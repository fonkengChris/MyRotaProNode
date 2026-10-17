const SolverSettings = require('../models/SolverSettings');
const User = require('../models/User');
const Shift = require('../models/Shift');
const Availability = require('../models/Availability');
const TimeOffRequest = require('../models/TimeOffRequest');
const { paidHoursAfterBreak, computeBreakDeduction, restHoursBetween } = require('../utils/shiftHours');
const Home = require('../models/Home');

// Default roles the AI solver auto-assigns. Admins configure the live list in
// SolverSettings.auto_assignable_roles; everyone else is rostered by hand on the rota grid.
const AUTO_ASSIGNABLE_ROLES = SolverSettings.DEFAULTS.auto_assignable_roles;

// Ranking tiers per employment type used when ordering candidates for a shift:
// [below target_min, up to priority_soft_max, up to hard_max, beyond hard_max].
// The thresholds come from SolverSettings.hours; the tier values are fixed.
const PRIORITY_TIERS = {
  fulltime: [100, 80, 60, 20],
  parttime: [60, 60, 30, 5],
  bank: [25, 25, 10, 5]
};

/** YYYY-MM-DD for a Date or date string (shift.date). */
function shiftDateYmd(shift) {
  if (!shift || shift.date == null) return '';
  if (shift.date instanceof Date) return shift.date.toISOString().split('T')[0];
  const s = String(shift.date);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** YYYY-MM-DD shifted by `days` (calendar arithmetic, timezone-independent). */
function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Stable key for a shift (persisted id, or a synthetic one for unsaved test data). */
function shiftKeyOf(shift) {
  return (shift._id || shift.id || `${shiftDateYmd(shift)}-${shift.start_time}`).toString();
}

/** Local calendar weekend (Sat/Sun) for YYYY-MM-DD. */
function isWeekendYmd(ymd) {
  if (!ymd || ymd.length < 10) return false;
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
}


const { isOneToOne, extraRosteredHours } = require('../utils/oneToOne');

class AISolver {
  constructor() {
    this.settings = null;
    // home_id -> Home.break_policy, so weekly hours are counted after unpaid breaks
    this.breakPolicyByHome = new Map();
  }

  /** Paid hours a shift counts towards weekly limits (after the home's break deduction). */
  paidHours(shift) {
    return paidHoursAfterBreak(shift, this.breakPolicyByHome.get(String(shift.home_id)));
  }

  async loadBreakPolicies(shifts) {
    const homeIds = [...new Set(shifts.map((s) => String(s.home_id)).filter(Boolean))];
    try {
      const homes = await Home.find({ _id: { $in: homeIds } }).select('break_policy').lean();
      this.breakPolicyByHome = new Map(homes.map((h) => [String(h._id), h.break_policy]));
    } catch (error) {
      console.error('AI Solver: could not load home break policies, using defaults:', error.message);
    }
  }

  /**
   * Split [startDate, endDate] into contiguous 7-day blocks from start (matches timetable generation).
   */
  computeWeekSegments(startDate, endDate) {
    const segments = [];
    const cur = new Date(startDate);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);
    while (cur <= end) {
      const ws = new Date(cur);
      const we = new Date(cur);
      we.setDate(we.getDate() + 6);
      if (we > end) {
        we.setTime(end.getTime());
      }
      segments.push({
        weekStart: new Date(ws),
        weekEnd: new Date(we),
        startStr: ws.toISOString().split('T')[0],
        endStr: we.toISOString().split('T')[0]
      });
      cur.setDate(cur.getDate() + 7);
    }
    return segments;
  }

  /**
   * Update cumulative fairness stats from solved assignments (weekend + shift counts).
   */
  accumulateFairnessStats(assignments, priorFairness) {
    const weekend = priorFairness.weekendShifts || (priorFairness.weekendShifts = {});
    const counts = priorFairness.shiftCounts || (priorFairness.shiftCounts = {});
    for (const row of assignments || []) {
      const ymd = shiftDateYmd(row.shift);
      const wknd = isWeekendYmd(ymd);
      for (const ass of row.assignments || []) {
        if (!ass || !ass.user_id) continue;
        const id = ass.user_id.toString();
        counts[id] = (counts[id] || 0) + 1;
        if (wknd) {
          weekend[id] = (weekend[id] || 0) + 1;
        }
      }
    }
  }

  /** Keep master shift list in sync for cross-week overlap checks on later segments. */
  applySolvedAssignmentsToShiftRefs(masterShifts, segmentAssignments) {
    for (const row of segmentAssignments || []) {
      if (!row.shift) continue;
      const sid = (row.shift._id || row.shift.id || '').toString();
      if (!sid) continue;
      const target = masterShifts.find((s) => (s._id || s.id || '').toString() === sid);
      if (!target) continue;
      target.assigned_staff = (row.assignments || []).map((a) => ({
        user_id: a.user_id,
        status: a.status || 'assigned',
        assigned_at: a.assigned_at || new Date(),
        note: a.note || ''
      }));
    }
  }

  // Load the org-wide solver rules (admin-editable, see models/SolverSettings.js)
  async initialize() {
    try {
      const settings = await SolverSettings.getSettings();
      this.settings = settings.toObject ? settings.toObject() : settings;
      return true;
    } catch (error) {
      console.error('AI Solver initialization error:', error);
      throw new Error('Failed to initialize AI solver');
    }
  }

  // Main method to generate rota assignments
  // serviceId: omit or pass null/undefined to include all services (multi-service / cross-service staff)
  // options.allowedRoles: overrides AUTO_ASSIGNABLE_ROLES for callers that need a
  //   different pool (defaults to support workers only)
  async generateRota(weekStartDate, weekEndDate, homeIds, serviceId, existingShifts = [], options = {}) {
    try {
      await this.initialize();
      const allowedRoleList = options.allowedRoles || this.settings.auto_assignable_roles;
      const allowedRoles = new Set(allowedRoleList);
      // Convert string dates to Date objects if needed
      const startDate = typeof weekStartDate === 'string' ? new Date(weekStartDate) : weekStartDate;
      const endDate = typeof weekEndDate === 'string' ? new Date(weekEndDate) : weekEndDate;
      
      // Ensure homeIds is always an array
      const homeIdArray = Array.isArray(homeIds) ? homeIds : [homeIds];
      
      // Get all available staff for all specified homes
      const mongoose = require('mongoose');
      const homeIdObjs = homeIdArray.map(homeId => 
        typeof homeId === 'string' ? new mongoose.Types.ObjectId(homeId) : homeId
      );
      
      const allStaff = await User.find({ 
        'homes.home_id': { $in: homeIdObjs }, 
        is_active: true 
      }).select('_id name role skills preferred_shift_types max_hours_per_week type homes');
      
      if (allStaff.length === 0) {
        throw new Error('No staff available for the specified homes');
      }

      // Keep only auto-assignable roles. `role` is already canonical here (the User
      // model normalizes legacy values such as home_manager on hydration).
      const staff = allStaff.filter((member) => allowedRoles.has(member.role));

      if (staff.length === 0) {
        throw new Error(
          `No assignable staff for the specified homes. The AI solver only allocates: ${allowedRoleList.join(', ')}. ` +
          'Other roles are rostered manually on the rota grid.'
        );
      }

      if (staff.length < allStaff.length) {
        console.log(
          `AI Solver: ${staff.length}/${allStaff.length} staff member(s) are auto-assignable (roles: ${allowedRoleList.join(', ')})`
        );
      }

      // Get all home IDs where staff members work (not just the target homes)
      const allStaffHomeIds = new Set();
      staff.forEach(staffMember => {
        staffMember.homes.forEach(home => {
          allStaffHomeIds.add(home.home_id.toString());
        });
      });
      
      console.log(`AI Solver: Staff members work across ${allStaffHomeIds.size} homes:`, Array.from(allStaffHomeIds));

      // Get availability data for the week across all homes
      const availabilityData = await this.getAvailabilityData(staff.map(s => s._id), startDate, endDate);
      
      // Get time off requests for the week across all homes
      const timeOffData = await this.getTimeOffData(staff.map(s => s._id), startDate, endDate);
      
      // Use existing shifts from rota grid or fetch from database for all homes where staff work
      let shifts = existingShifts;
      if (shifts.length === 0) {
        const Shift = require('../models/Shift');
        // Include every target home in the fetch set (not only homes linked on staff profiles)
        const mergedHomeIdSet = new Set(allStaffHomeIds);
        homeIdArray.forEach((hid) => mergedHomeIdSet.add(hid.toString()));

        const allHomeIdObjs = Array.from(mergedHomeIdSet).map((homeId) =>
          typeof homeId === 'string' ? new mongoose.Types.ObjectId(homeId) : homeId
        );

        shifts = await Shift.find({
          home_id: { $in: allHomeIdObjs },
          date: {
            $gte: startDate.toISOString().split('T')[0],
            $lte: endDate.toISOString().split('T')[0]
          }
        }).populate('service_id', 'name');

        console.log(`AI Solver: Found ${shifts.length} existing shifts across merged homes for the week`);

        const targetHomeIds = new Set(homeIdArray.map((id) => id.toString()));

        // 1) Materialize any missing weekly-schedule shifts (unassigned) for each target home — always,
        //    not only when a home had zero shifts (fixes partial weeks / missing slots).
        await this.ensureShiftsFromWeeklyScheduleForHomes(startDate, endDate, homeIdArray, serviceId);

        // 2) Reload shifts so the solver sees every persisted row before assignment.
        shifts = await Shift.find({
          home_id: { $in: allHomeIdObjs },
          date: {
            $gte: startDate.toISOString().split('T')[0],
            $lte: endDate.toISOString().split('T')[0]
          }
        }).populate('service_id', 'name');

        console.log(`AI Solver: ${shifts.length} shift(s) in scope after ensuring weekly schedules`);

        const targetHomeShifts = shifts.filter((shift) => targetHomeIds.has(shift.home_id.toString()));

        if (targetHomeShifts.length === 0) {
          throw new Error(
            'No shifts found or could be created for the specified target homes and week. Please create shifts or weekly schedules first before using AI generation.'
          );
        }
      }
      
      // 1-to-1 shifts are created and assigned by admins only; the solver never fills them.
      // Their uncovered hours still count towards each person's weekly limits.
      const oneToOneShifts = shifts.filter((shift) => isOneToOne(shift));
      shifts = shifts.filter((shift) => !isOneToOne(shift));
      await this.loadBreakPolicies([...shifts, ...oneToOneShifts]);

      // Solve week-by-week when the range spans multiple segments so fairness (e.g. weekends)
      // carries forward; overlap/rest checks use the full in-memory rota built so far.
      const segments = this.computeWeekSegments(startDate, endDate);
      const priorFairness = { weekendShifts: {}, shiftCounts: {} };
      const externalWorkDates = this.settings.consecutive_days_enabled
        ? await this.getExternalWorkDates(staff.map((s) => s._id), startDate, endDate)
        : {};

      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const segmentShifts = shifts.filter((s) => {
          const d = shiftDateYmd(s);
          return d >= seg.startStr && d <= seg.endStr;
        });
        if (segmentShifts.length === 0) {
          continue;
        }

        console.log(
          `AI Solver: Solving segment ${si + 1}/${segments.length} (${seg.startStr} – ${seg.endStr}), ${segmentShifts.length} shift(s)`
        );

        const segmentAssignments = await this.solveMultiHomeAssignmentProblem(
          segmentShifts,
          staff,
          availabilityData,
          timeOffData,
          homeIdArray,
          {
            overlapContextShifts: shifts,
            segmentShiftsForHours: segmentShifts,
            priorFairness,
            externalWorkDates,
            baseHoursByUser: this.oneToOneHoursByUser(
              oneToOneShifts.filter((s) => {
                const d = shiftDateYmd(s);
                return d >= seg.startStr && d <= seg.endStr;
              }),
              shifts
            )
          }
        );

        const hasValidShiftIds = segmentAssignments.some((assignment) => {
          const shiftId = assignment.shift._id || assignment.shift.id;
          return mongoose.Types.ObjectId.isValid(shiftId);
        });

        if (hasValidShiftIds) {
          await this.applyAssignmentsToDatabaseIncrementally(segmentAssignments);
        } else {
          console.log('AI Solver: Skipping database application for segment - shifts appear to be test data');
        }

        this.accumulateFairnessStats(segmentAssignments, priorFairness);
        this.applySolvedAssignmentsToShiftRefs(shifts, segmentAssignments);
      }

      const assignments = shifts.map((shift) => ({
        shift,
        assignments: shift.assigned_staff || []
      }));

      const hasValidShiftIds = assignments.some((assignment) => {
        const shiftId = assignment.shift._id || assignment.shift.id;
        return mongoose.Types.ObjectId.isValid(shiftId);
      });
      if (!hasValidShiftIds) {
        console.log('AI Solver: No persisted shift IDs in result (test data or empty range)');
      }
      
      // Get employment type distribution summary
      let employmentDistribution = null;
      try {
        employmentDistribution = this.getEmploymentTypeDistribution(assignments, staff);
      } catch (error) {
        console.error('AI Solver: Error calculating employment distribution:', error);
        employmentDistribution = {
          fulltime: { total_hours: 0, staff_count: 0, average_hours: 0 },
          parttime: { total_hours: 0, staff_count: 0, average_hours: 0 },
          bank: { total_hours: 0, staff_count: 0, average_hours: 0 }
        };
      }
      
      return {
        success: true,
        assignments,
        total_penalty: this.calculateTotalPenalty(assignments),
        constraints_violated: this.getViolatedConstraints(assignments),
        employment_distribution: employmentDistribution,
        homes_processed: homeIdArray.length,
        total_homes_considered: allStaffHomeIds.size
      };
      
    } catch (error) {
      console.error('Rota generation error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Paid hours (after breaks) each staff member's 1-to-1 shifts add outside the background
   * shifts they already hold. Shifts the solver adds later aren't subtracted, so this errs
   * towards counting more hours, never fewer. Returns { [userId]: hours }.
   */
  oneToOneHoursByUser(oneToOneShifts, backgroundShifts) {
    const result = {};
    for (const o of oneToOneShifts) {
      const policy = this.breakPolicyByHome.get(String(o.home_id));
      for (const a of o.assigned_staff || []) {
        if (!a || !a.user_id) continue;
        const id = a.user_id.toString();
        const held = backgroundShifts.filter((s) =>
          (s.assigned_staff || []).some((x) => x && x.user_id && x.user_id.toString() === id)
        );
        const extra = extraRosteredHours(o, held);
        result[id] = (result[id] || 0) + Math.max(0, extra - computeBreakDeduction(extra, policy));
      }
    }
    return result;
  }

  // Get availability data for staff
  async getAvailabilityData(staffIds, startDate, endDate) {
    try {
      // Convert Date objects to string format to match stored availability records
      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = endDate.toISOString().split('T')[0];
      
      const availability = await Availability.find({
        user_id: { $in: staffIds },
        date: { $gte: startDateStr, $lte: endDateStr }
      });
      
      return availability;
    } catch (error) {
      console.error('Error fetching availability data:', error);
      return [];
    }
  }

  /**
   * Dates each staff member already works just outside [startDate, endDate], so the
   * consecutive-days rule sees runs that start before (or continue after) the range.
   * Returns { [userId]: Set<YYYY-MM-DD> }.
   */
  async getExternalWorkDates(staffIds, startDate, endDate) {
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    const span = this.settings.max_consecutive_days;
    const idSet = new Set(staffIds.map((id) => id.toString()));
    const result = {};
    try {
      const nearby = await Shift.find({
        'assigned_staff.user_id': { $in: staffIds },
        date: { $gte: addDaysYmd(startStr, -span), $lte: addDaysYmd(endStr, span) }
      }).select('date assigned_staff.user_id').lean();
      for (const shift of nearby) {
        if (shift.date >= startStr && shift.date <= endStr) continue;
        for (const a of shift.assigned_staff || []) {
          const id = a.user_id && a.user_id.toString();
          if (!id || !idSet.has(id)) continue;
          (result[id] = result[id] || new Set()).add(shift.date);
        }
      }
    } catch (error) {
      console.error('Error fetching work dates outside the solve range:', error);
    }
    return result;
  }

  // Get time off data for staff
  async getTimeOffData(staffIds, startDate, endDate) {
    try {
      // Convert Date objects to string format for comparison
      const startDateStr = startDate instanceof Date ? startDate.toISOString().split('T')[0] : startDate;
      const endDateStr = endDate instanceof Date ? endDate.toISOString().split('T')[0] : endDate;
      
      const timeOff = await TimeOffRequest.find({
        user_id: { $in: staffIds },
        status: 'approved',
        start_date: { $lte: endDateStr },
        end_date: { $gte: startDateStr }
      });
      
      return timeOff;
    } catch (error) {
      console.error('Error fetching time off data:', error);
      return [];
    }
  }

  // Generate shifts based on the home's weekly schedule
  async generateShiftsFromWeeklySchedule(startDate, endDate, homeId, serviceId) {
    try {
      // Import WeeklySchedule model
      const WeeklySchedule = require('../models/WeeklySchedule');
      
      // Fetch the home's weekly schedule
      const weeklySchedule = await WeeklySchedule.findOne({ home_id: homeId });
      
      if (!weeklySchedule) {
        throw new Error(`No weekly schedule found for home ${homeId}. Please create a weekly schedule for this home first.`);
      }
      
      const shifts = [];
      const currentDate = new Date(startDate);
      
      // Day names for mapping
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      
      while (currentDate <= new Date(endDate)) {
        const dayName = dayNames[currentDate.getDay()];
        const daySchedule = weeklySchedule.schedule[dayName];
        
        if (daySchedule && daySchedule.is_active && daySchedule.shifts && daySchedule.shifts.length > 0) {
          daySchedule.shifts.forEach((shiftPattern, index) => {
            // Only create shifts for the specified service if serviceId is provided
            if (!serviceId || shiftPattern.service_id.toString() === serviceId.toString()) {
              const shift = {
                _id: `generated-${currentDate.toISOString().split('T')[0]}-${shiftPattern.start_time.replace(':', '-')}`,
                date: new Date(currentDate),
                start_time: shiftPattern.start_time,
                end_time: shiftPattern.end_time,
                shift_type: shiftPattern.shift_type,
                required_staff_count: shiftPattern.required_staff_count,
                service_id: shiftPattern.service_id
              };
              
              shifts.push(shift);
            }
          });
        }
        
        currentDate.setDate(currentDate.getDate() + 1);
      }
      
      if (shifts.length === 0) {
        throw new Error(`No shifts could be generated from the weekly schedule for home ${homeId}. Please check the weekly schedule configuration.`);
      }
      

      return shifts;
      
    } catch (error) {
      console.error('AI Solver: Error generating shifts from weekly schedule:', error);
      throw new Error(`Failed to generate shifts from weekly schedule: ${error.message}`);
    }
  }

  /**
   * Persist shift rows from weekly schedules for target homes before assignment runs.
   * Inserts only missing shifts (same home, date, times, service) so partial weeks are filled in.
   * All new shifts are created with assigned_staff: [] so they exist whether or not the solver assigns anyone.
   */
  async ensureShiftsFromWeeklyScheduleForHomes(startDate, endDate, homeIds, serviceId) {
    const mongoose = require('mongoose');
    const Shift = require('../models/Shift');
    let createdCount = 0;

    for (const rawHomeId of homeIds) {
      let generatedShifts;
      try {
        generatedShifts = await this.generateShiftsFromWeeklySchedule(startDate, endDate, rawHomeId, serviceId);
      } catch (error) {
        console.warn(
          `AI Solver: Could not materialize weekly schedule for home ${rawHomeId}: ${error.message}`
        );
        continue;
      }

      const homeObjectId =
        typeof rawHomeId === 'string' ? new mongoose.Types.ObjectId(rawHomeId) : rawHomeId;

      for (const generatedShift of generatedShifts) {
        const dateStr =
          generatedShift.date instanceof Date
            ? generatedShift.date.toISOString().split('T')[0]
            : String(generatedShift.date).slice(0, 10);

        const serviceObjectId =
          generatedShift.service_id && typeof generatedShift.service_id === 'string'
            ? new mongoose.Types.ObjectId(generatedShift.service_id)
            : generatedShift.service_id;

        const existing = await Shift.findOne({
          home_id: homeObjectId,
          date: dateStr,
          start_time: generatedShift.start_time,
          end_time: generatedShift.end_time,
          service_id: serviceObjectId,
          shift_type: { $ne: 'one_to_one' }
        });
        if (existing) {
          continue;
        }

        const shiftData = {
          home_id: homeObjectId,
          service_id: serviceObjectId,
          date: dateStr,
          start_time: generatedShift.start_time,
          end_time: generatedShift.end_time,
          shift_type: generatedShift.shift_type,
          required_staff_count: generatedShift.required_staff_count,
          notes: generatedShift.notes || '',
          is_active: true,
          assigned_staff: [],
          is_urgent: false
        };

        const newShift = new Shift(shiftData);
        await newShift.save();
        createdCount++;
      }
    }

    if (createdCount > 0) {
      console.log(`AI Solver: Created ${createdCount} missing shift document(s) from weekly schedules (unassigned)`);
    }
    return createdCount;
  }

  // Solve the assignment problem using constraint optimization for multiple homes
  async solveMultiHomeAssignmentProblem(shifts, staff, availabilityData, timeOffData, homeIds, options = {}) {
    try {
      // Filter shifts to only include those that need staff assignment
      const shiftsNeedingStaff = shifts.filter(shift => {
        const currentAssignments = shift.assigned_staff || [];
        const requiredStaff = shift.required_staff_count || 1;
        return currentAssignments.length < requiredStaff;
      });
      
      if (shiftsNeedingStaff.length === 0) {
        return shifts.map(shift => ({
          shift: shift,
          assignments: shift.assigned_staff || []
        }));
      }

      const overlapContextShifts = options.overlapContextShifts || shifts;
      const segmentShiftsForHours = options.segmentShiftsForHours || shifts;
      const priorFairness = options.priorFairness || { weekendShifts: {}, shiftCounts: {} };
      const externalWorkDates = options.externalWorkDates || {};
      const baseHoursByUser = options.baseHoursByUser || {};
      const solveContext = { overlapContextShifts, segmentShiftsForHours, externalWorkDates, baseHoursByUser, staff };
      
      // Build constraint matrix for unassigned shifts only, considering multi-home assignments
      const constraints = this.buildMultiHomeConstraintMatrix(
        shiftsNeedingStaff,
        staff,
        availabilityData,
        timeOffData,
        homeIds,
        { overlapContextShifts, segmentShiftsForHours, priorFairness, baseHoursByUser }
      );
      
      // Use greedy algorithm for initial assignment with multi-home awareness
      const newAssignments = this.greedyMultiHomeAssignment(
        shiftsNeedingStaff,
        staff,
        constraints,
        homeIds,
        { ...solveContext, priorFairness }
      );
      
      // Apply local search optimization
      const optimizedNewAssignments = this.localSearchOptimization(newAssignments, constraints, solveContext);
      
      // Merge new assignments with existing assignments
      const allAssignments = shifts.map(shift => {
        const existingAssignments = shift.assigned_staff || [];
        const newAssignmentsForShift = optimizedNewAssignments.find(na => 
          na.shift._id === shift._id || na.shift.id === shift.id
        );
        
        if (newAssignmentsForShift) {
          // Combine existing and new assignments
          const combinedAssignments = [...existingAssignments];
          
          // Add new assignments for staff not already assigned
          newAssignmentsForShift.assignments.forEach(newAssignment => {
            const isAlreadyAssigned = existingAssignments.some(existing => 
              existing.user_id.toString() === newAssignment.user_id.toString()
            );
            
            if (!isAlreadyAssigned) {
              combinedAssignments.push(newAssignment);
            }
          });
          
          return {
            shift: shift,
            assignments: combinedAssignments
          };
        } else {
          // No new assignments for this shift, return existing
          return {
            shift: shift,
            assignments: existingAssignments
          };
        }
      });
      
      return allAssignments;
      
    } catch (error) {
      console.error('Multi-home assignment problem solving error:', error);
      throw new Error('Failed to solve multi-home assignment problem');
    }
  }

  // Build constraint matrix for all staff-shift combinations considering multi-home assignments
  buildMultiHomeConstraintMatrix(shifts, staff, availabilityData, timeOffData, homeIds, matrixOptions = {}) {
    const constraints = {};
    const overlapShifts = matrixOptions.overlapContextShifts || shifts;
    const hourScopeShifts = matrixOptions.segmentShiftsForHours || matrixOptions.overlapContextShifts || shifts;
    const priorFairness = matrixOptions.priorFairness || { weekendShifts: {}, shiftCounts: {} };
    const priorWeekend = priorFairness.weekendShifts || {};
    const priorShiftCounts = priorFairness.shiftCounts || {};
    const { fairness, scoring } = this.settings;

    // Hours for employment-type scoring: current segment only (weekly caps stay per week).
    const staffCurrentHours = this.calculateStaffCurrentHoursAcrossHomes(hourScopeShifts, staff, homeIds);
    for (const [id, hours] of Object.entries(matrixOptions.baseHoursByUser || {})) {
      if (staffCurrentHours[id] !== undefined) staffCurrentHours[id] += hours;
    }
    
    staff.forEach(staffMember => {
      constraints[staffMember._id] = {};
      
      shifts.forEach(shift => {
        // Handle both Date objects and string dates
        let shiftDate;
        if (shift.date instanceof Date) {
          shiftDate = shift.date.toISOString().split('T')[0];
        } else if (typeof shift.date === 'string') {
          shiftDate = shift.date;
        } else {
          shiftDate = 'unknown';
        }

        const shiftKey = shift._id || shift.id || `${shiftDate}-${shift.start_time}`;
        
        // Check if staff member has access to this shift's home
        const hasHomeAccess = staffMember.homes.some(home => 
          home.home_id.toString() === shift.home_id.toString()
        );
        
        if (!hasHomeAccess) {
          // Staff member doesn't have access to this home
          constraints[staffMember._id][shiftKey] = 0;
          return;
        }
        
        // Check if staff member is already assigned to this shift
        const isAlreadyAssigned = shift.assigned_staff && shift.assigned_staff.some(assignment => 
          assignment.user_id.toString() === staffMember._id.toString()
        );
        
        if (isAlreadyAssigned) {
          // Staff member is already assigned to this shift
          constraints[staffMember._id][shiftKey] = 0;
          return;
        }

        // Overlap or too little rest against shifts this staff member already holds
        const hasOverlappingShift = this.checkForOverlappingShifts(staffMember._id, shift, overlapShifts);
        
        if (hasOverlappingShift) {
          // Staff member has overlapping shifts
          constraints[staffMember._id][shiftKey] = 0;
          return;
        }
        
        // Check availability
        const availability = availabilityData.find(av => 
          av.user_id.toString() === staffMember._id.toString() && 
          av.date === shiftDate
        );
        
        // Check time off
        const timeOff = timeOffData.find(to => 
          to.user_id.toString() === staffMember._id.toString() && 
          to.start_date <= shiftDate && 
          to.end_date >= shiftDate &&
          to.status === 'approved'
        );
        
        // Calculate constraint score
        let score = 100; // Base score - assume available by default
        
        if (timeOff) {
          score = 0; // Time off approved
        } else if (availability && !availability.is_available) {
          score = 0; // Explicitly marked as unavailable
        } else {
          // Staff is available (either no record exists or explicitly marked as available)
          
          // Apply soft constraints if availability data exists
          if (availability && availability.preferred_shift_types && 
              availability.preferred_shift_types.length > 0 &&
              !availability.preferred_shift_types.includes(shift.shift_type)) {
            score -= scoring.non_preferred_shift_type_penalty;
          }
          
          if (availability && availability.start_time && 
              availability.end_time &&
              !this.isTimeInRange(shift.start_time, availability.start_time, availability.end_time)) {
            score -= scoring.outside_available_hours_penalty;
          }
          
          // Apply employment type constraints with multi-home awareness
          score = this.applyMultiHomeEmploymentTypeConstraints(
            score, 
            staffMember, 
            shift, 
            staffCurrentHours[staffMember._id.toString()] || 0,
            homeIds
          );

          const sid = staffMember._id.toString();
          const priorW = priorWeekend[sid] || 0;
          const priorC = priorShiftCounts[sid] || 0;
          if (isWeekendYmd(shiftDate) && priorW > 0) {
            score -= Math.min(fairness.weekend_penalty_cap, priorW * fairness.weekend_penalty_per_prior);
          }
          if (priorC > 0) {
            score -= Math.min(fairness.distribution_penalty_cap, priorC * fairness.distribution_penalty_per_prior);
          }
        }
        
        constraints[staffMember._id][shiftKey] = Math.max(score, 0);
      });
    });
    
    return constraints;
  }

  // Calculate current hours for each staff member from existing assignments across multiple homes
  calculateStaffCurrentHoursAcrossHomes(shifts, staff, homeIds) {
    const staffHours = {};
    const homeIdSet = new Set(homeIds.map((h) => (typeof h === 'string' ? h : h.toString())));
    
    staff.forEach(staffMember => {
      staffHours[staffMember._id.toString()] = 0;
    });
    
    shifts.forEach(shift => {
      // Only count hours for shifts in the specified homes
      if (!homeIdSet.has(shift.home_id.toString())) {
        return;
      }
      
      if (shift.assigned_staff && shift.assigned_staff.length > 0) {
        shift.assigned_staff.forEach(assignment => {
          const staffId = assignment.user_id.toString();
          if (staffHours[staffId] !== undefined) {
            staffHours[staffId] += this.paidHours(shift);
          }
        });
      }
    });
    
    return staffHours;
  }

  // Apply employment type constraints to scoring with multi-home awareness
  applyMultiHomeEmploymentTypeConstraints(baseScore, staffMember, shift, currentHours, homeIds) {
    const rule = this.settings.hours[staffMember.type];
    if (!rule) return baseScore;

    let score = baseScore;
    const projectedHours = currentHours + this.paidHours(shift);

    if (projectedHours < rule.target_min) {
      score += rule.below_target_bonus;
    } else if (projectedHours <= rule.band_upper) {
      score += rule.in_band_bonus;
    } else if (projectedHours > rule.over_penalty_threshold) {
      score -= rule.over_penalty;
    }

    const isDefaultHome = staffMember.homes.some(home =>
      home.home_id.toString() === shift.home_id.toString() && home.is_default
    );
    if (isDefaultHome) {
      score += rule.default_home_bonus;
    }

    return score;
  }

  // Greedy assignment algorithm with balanced distribution for multiple homes
  greedyMultiHomeAssignment(shifts, staff, constraints, homeIds, options = {}) {
    const assignments = [];
    const segmentShiftsForHours = options.segmentShiftsForHours || shifts;
    const priorFairness = options.priorFairness || { weekendShifts: {}, shiftCounts: {} };
    const priorWeekendInit = priorFairness.weekendShifts || {};
    const priorShiftCountsInit = priorFairness.shiftCounts || {};
    const externalWorkDates = options.externalWorkDates || {};
    const { hours: hourRules, type_mix: typeMix, scoring } = this.settings;
    // Shifts each staff member holds (persisted + assigned during this pass), for rest,
    // overlap and consecutive-day checks against assignments made earlier in the pass.
    const staffShiftMap = this.buildStaffShiftMap(options.overlapContextShifts || shifts);

    const staffShiftCounts = {}; // Rolling shift count (prior weeks + this segment)
    const staffWeekendShifts = {}; // Weekend shifts in prior weeks + this segment
    const staffCurrentHours = {}; // Current segment only (seeded from partial assignments)
    const staffHomeAssignments = {}; // Track assignments per home for each staff member
    
    staff.forEach(s => {
      const id = s._id.toString();
      staffShiftCounts[id] = priorShiftCountsInit[id] || 0;
      staffWeekendShifts[id] = priorWeekendInit[id] || 0;
      staffCurrentHours[id] = (options.baseHoursByUser || {})[id] || 0;
      staffHomeAssignments[id] = {};
      homeIds.forEach(homeId => {
        const hk = typeof homeId === 'string' ? homeId : homeId.toString();
        staffHomeAssignments[id][hk] = 0;
      });
    });

    segmentShiftsForHours.forEach(shift => {
      const paid = this.paidHours(shift);
      for (const a of shift.assigned_staff || []) {
        if (!a || !a.user_id) continue;
        const id = a.user_id.toString();
        if (staffCurrentHours[id] !== undefined) {
          staffCurrentHours[id] += paid;
        }
      }
    });
    
    // Categorize staff by employment type
    const fulltimeStaff = staff.filter(s => s.type === 'fulltime');
    const parttimeStaff = staff.filter(s => s.type === 'parttime');
    const bankStaff = staff.filter(s => s.type === 'bank');
    
    // Calculate target distribution (aim for more balanced distribution)
    const totalShifts = shifts.reduce((sum, shift) => sum + shift.required_staff_count, 0);
    const targetFulltimeShifts = Math.min(totalShifts * typeMix.fulltime_share, fulltimeStaff.length * typeMix.fulltime_max_per_head);
    const targetParttimeShifts = Math.min(totalShifts * typeMix.parttime_share, parttimeStaff.length * typeMix.parttime_max_per_head);
    const targetBankShifts = totalShifts - targetFulltimeShifts - targetParttimeShifts; // Remaining shifts
    
    // Date order first, then longer shifts.
    const sortedShifts = [...shifts].sort((a, b) => {
      const dateCmp = shiftDateYmd(a).localeCompare(shiftDateYmd(b));
      if (dateCmp !== 0) return dateCmp;

      const durationA = this.calculateShiftDuration(a.start_time, a.end_time);
      const durationB = this.calculateShiftDuration(b.start_time, b.end_time);
      if (durationA !== durationB) {
        return durationB - durationA;
      }
      return a.start_time.localeCompare(b.start_time);
    });
    
    let fulltimeShiftsAssigned = 0;
    let parttimeShiftsAssigned = 0;
    let bankShiftsAssigned = 0;
    
    sortedShifts.forEach((shift, index) => {
      const shiftId = shift._id || shift.id || `${shift.date}-${shift.start_time}`;
      const shiftAssignments = [];
      const shiftDuration = this.calculateShiftDuration(shift.start_time, shift.end_time);
      const shiftPaidHours = this.paidHours(shift);
      const shiftHomeId = shift.home_id.toString();
      const shiftYmd = shiftDateYmd(shift);
      const shiftIsWeekend = isWeekendYmd(shiftYmd);
      
      // Determine which employment types to prioritize for this shift
      let prioritizedTypes = [];
      
      // Always prioritize full-time workers first if they're below target
      if (fulltimeShiftsAssigned < targetFulltimeShifts) {
        prioritizedTypes.push('fulltime');
      }
      
      // Then prioritize part-time workers if they're below target
      if (parttimeShiftsAssigned < targetParttimeShifts) {
        prioritizedTypes.push('parttime');
      }
      
      // Finally, use bank workers if needed
      if (bankShiftsAssigned < targetBankShifts || (fulltimeShiftsAssigned >= targetFulltimeShifts && parttimeShiftsAssigned >= targetParttimeShifts)) {
        prioritizedTypes.push('bank');
      }
      
      // Sort staff by prioritized types and constraint score
      const staffScores = staff
        .map(s => ({
          staffId: s._id,
          name: s.name,
          type: s.type,
          score: constraints[s._id] ? (constraints[s._id][shiftId] || 0) : 0,
          totalShiftsSoFar: staffShiftCounts[s._id.toString()] || 0,
          weekendSoFar: staffWeekendShifts[s._id.toString()] || 0,
          currentHours: staffCurrentHours[s._id.toString()] || 0,
          projectedHours: (staffCurrentHours[s._id.toString()] || 0) + shiftPaidHours,
          typePriority: prioritizedTypes.indexOf(s.type) >= 0 ? prioritizedTypes.indexOf(s.type) : 999, // Not prioritized = very low priority
          homeAssignments: staffHomeAssignments[s._id.toString()][shiftHomeId] || 0,
          isDefaultHome: s.homes.some(home => home.home_id.toString() === shiftHomeId && home.is_default)
        }))
        .filter(s => s.score > 0) // Only consider available staff
        .filter(s => {
          // Hard weekly hours limit for the employment type
          const rule = hourRules[s.type] || hourRules.bank;
          return s.projectedHours <= rule.hard_max;
        })
        .filter(s => {
          const held = this.heldShifts(staffShiftMap, s.staffId);
          if (this.violatesRestOrOverlap(shift, held)) return false;
          const dates = this.workDates(held, externalWorkDates[s.staffId.toString()]);
          return !this.exceedsConsecutiveDays(dates, shiftYmd);
        })
      
      const sortedStaffScores = staffScores.sort((a, b) => {
          // Primary sort by type priority (prioritized types first)
          if (a.typePriority !== b.typePriority) {
            return a.typePriority - b.typePriority; // Lower index = higher priority
          }
          
          // Secondary sort by employment type priority within the same type
          const typePriorityA = this.getEmploymentTypePriority(a.type, a.projectedHours);
          const typePriorityB = this.getEmploymentTypePriority(b.type, b.projectedHours);
          
          if (typePriorityA !== typePriorityB) {
            return typePriorityB - typePriorityA; // Higher priority first
          }
          
          // Tertiary sort by constraint score (with type-based weighting)
          const weightedScoreA = a.score + (a.isDefaultHome ? scoring.default_home_sort_boost : 0); // Boost default home workers
          const weightedScoreB = b.score + (b.isDefaultHome ? scoring.default_home_sort_boost : 0);
          
          if (weightedScoreA !== weightedScoreB) {
            return weightedScoreB - weightedScoreA;
          }

          if (shiftIsWeekend && a.weekendSoFar !== b.weekendSoFar) {
            return a.weekendSoFar - b.weekendSoFar;
          }

          if (a.totalShiftsSoFar !== b.totalShiftsSoFar) {
            return a.totalShiftsSoFar - b.totalShiftsSoFar;
          }
          
          // Prefer staff with fewer hours this segment
          return a.currentHours - b.currentHours;
        });
      
      // Assign required number of staff
      for (let i = 0; i < shift.required_staff_count && i < sortedStaffScores.length; i++) {
        const staffMember = sortedStaffScores[i];
        
        shiftAssignments.push({
          shift_id: shiftId,
          user_id: staffMember.staffId,
          status: 'assigned',
          score: staffMember.score
        });
        
        // Update shift count and hours for this staff member
        const sid = staffMember.staffId.toString();
        staffShiftCounts[sid]++;
        staffCurrentHours[sid] += shiftPaidHours;
        staffHomeAssignments[sid][shiftHomeId]++;
        this.addHeldShift(staffShiftMap, sid, shift);
        if (shiftIsWeekend) {
          staffWeekendShifts[sid]++;
        }
        
        // Update type-specific counters
        if (staffMember.type === 'fulltime') {
          fulltimeShiftsAssigned++;
        } else if (staffMember.type === 'parttime') {
          parttimeShiftsAssigned++;
        } else if (staffMember.type === 'bank') {
          bankShiftsAssigned++;
        }
      }
      
      assignments.push({
        shift: shift,
        assignments: shiftAssignments
      });
    });
    
    return assignments;
  }

  // Local search optimization
  localSearchOptimization(assignments, constraints, context = {}) {
    let improved = true;
    let iterations = 0;
    const maxIterations = 100;
    const swapContext = {
      ...context,
      staffById: new Map((context.staff || []).map((m) => [m._id.toString(), m])),
      segmentKeys: new Set((context.segmentShiftsForHours || assignments.map((r) => r.shift)).map(shiftKeyOf))
    };
    
    while (improved && iterations < maxIterations) {
      improved = false;
      iterations++;
      
      // Try to improve assignments by swapping staff between shifts
      for (let i = 0; i < assignments.length; i++) {
        for (let j = i + 1; j < assignments.length; j++) {
          const improvement = this.trySwap(assignments[i], assignments[j], constraints, assignments, swapContext);
          if (improvement > 0) {
            improved = true;
          }
        }
      }
    }
    
    return assignments;
  }

  // Try to swap staff between two shifts
  trySwap(row1, row2, constraints, allRows = [row1, row2], context = {}) {
    let bestImprovement = 0;
    let bestSwap = null;

    const k1 = shiftKeyOf(row1.shift);
    const k2 = shiftKeyOf(row2.shift);
    const scoreOf = (userId, key) => (constraints[userId] && constraints[userId][key]) || 0;
    
    row1.assignments.forEach(assignment1 => {
      row2.assignments.forEach(assignment2 => {
        const u1 = assignment1.user_id;
        const u2 = assignment2.user_id;
        if (u1.toString() === u2.toString()) return;

        // A zero score means unavailable / on leave / no home access for that shift.
        const swappedU1 = scoreOf(u1, k2);
        const swappedU2 = scoreOf(u2, k1);
        if (swappedU1 <= 0 || swappedU2 <= 0) return;

        const improvement = (swappedU1 + swappedU2) - (scoreOf(u1, k1) + scoreOf(u2, k2));
        
        if (improvement > bestImprovement &&
            this.isValidSwap(assignment1, assignment2, row1, row2, allRows, context)) {
          bestImprovement = improvement;
          bestSwap = { assignment1, assignment2 };
        }
      });
    });
    
    if (bestSwap && bestImprovement > 0) {
      const temp = bestSwap.assignment1.user_id;
      bestSwap.assignment1.user_id = bestSwap.assignment2.user_id;
      bestSwap.assignment2.user_id = temp;
      
      bestSwap.assignment1.score = scoreOf(bestSwap.assignment1.user_id, k1);
      bestSwap.assignment2.score = scoreOf(bestSwap.assignment2.user_id, k2);
    }
    
    return bestImprovement;
  }

  // A swap is valid when both staff can take the other's shift without breaking the
  // weekly hours cap, overlap/rest rules or the consecutive-days limit.
  isValidSwap(assignment1, assignment2, row1, row2, allRows, context) {
    const staffShiftMap = this.buildStaffShiftMap(context.overlapContextShifts || [], allRows);
    return (
      this.canMoveStaff(assignment1.user_id, row1.shift, row2.shift, staffShiftMap, context) &&
      this.canMoveStaff(assignment2.user_id, row2.shift, row1.shift, staffShiftMap, context)
    );
  }

  canMoveStaff(userId, fromShift, toShift, staffShiftMap, context) {
    const id = userId.toString();
    const held = staffShiftMap.get(id) || new Map();
    const fromKey = shiftKeyOf(fromShift);
    if (held.has(shiftKeyOf(toShift))) return false; // already on that shift

    const remaining = [...held.entries()].filter(([key]) => key !== fromKey).map(([, s]) => s);
    if (this.violatesRestOrOverlap(toShift, remaining)) return false;

    const member = context.staffById && context.staffById.get(id);
    const rule = member && (this.settings.hours[member.type] || this.settings.hours.bank);
    if (rule) {
      const segmentKeys = context.segmentKeys || new Set();
      const weekHours = remaining
        .filter((s) => segmentKeys.has(shiftKeyOf(s)))
        .reduce((sum, s) => sum + this.paidHours(s), (context.baseHoursByUser || {})[id] || 0);
      if (weekHours + this.paidHours(toShift) > rule.hard_max) return false;
    }

    const external = context.externalWorkDates && context.externalWorkDates[id];
    return !this.exceedsConsecutiveDays(this.workDates(remaining, external), shiftDateYmd(toShift));
  }

  /**
   * userId -> Map(shiftKey -> shift) of shifts each staff member holds: persisted
   * assignments on `contextShifts` plus the solver's new `rows` ({ shift, assignments }).
   */
  buildStaffShiftMap(contextShifts, rows = []) {
    const map = new Map();
    for (const shift of contextShifts || []) {
      for (const a of shift.assigned_staff || []) {
        if (a && a.user_id) this.addHeldShift(map, a.user_id, shift);
      }
    }
    for (const row of rows) {
      for (const a of row.assignments || []) {
        if (a && a.user_id) this.addHeldShift(map, a.user_id, row.shift);
      }
    }
    return map;
  }

  addHeldShift(staffShiftMap, userId, shift) {
    const id = userId.toString();
    if (!staffShiftMap.has(id)) staffShiftMap.set(id, new Map());
    staffShiftMap.get(id).set(shiftKeyOf(shift), shift);
  }

  heldShifts(staffShiftMap, userId) {
    const held = staffShiftMap.get(userId.toString());
    return held ? [...held.values()] : [];
  }

  /** Calendar dates (YYYY-MM-DD) worked: the given shifts plus any extra known dates. */
  workDates(shifts, extraDates) {
    const dates = new Set(extraDates || []);
    for (const s of shifts) dates.add(shiftDateYmd(s));
    return dates;
  }

  /** Whether working `ymd` would make a run of working days longer than allowed. */
  exceedsConsecutiveDays(workedDates, ymd) {
    if (!this.settings.consecutive_days_enabled) return false;
    if (workedDates.has(ymd)) return false; // already working that day
    let run = 1;
    for (let d = addDaysYmd(ymd, -1); workedDates.has(d); d = addDaysYmd(d, -1)) run++;
    for (let d = addDaysYmd(ymd, 1); workedDates.has(d); d = addDaysYmd(d, 1)) run++;
    return run > this.settings.max_consecutive_days;
  }

  // Calculate total penalty for all assignments
  calculateTotalPenalty(assignments) {
    let totalPenalty = 0;
    
    assignments.forEach(assignment => {
      assignment.assignments.forEach(ass => {
        totalPenalty += (100 - ass.score); // Penalty is inverse of score
      });
    });
    
    return totalPenalty;
  }

  // Helper method to check if a time is within a range
  isTimeInRange(time, startTime, endTime) {
    const timeMinutes = this.timeToMinutes(time);
    const startMinutes = this.timeToMinutes(startTime);
    const endMinutes = this.timeToMinutes(endTime);
    
    if (endMinutes < startMinutes) {
      // Overnight shift
      return timeMinutes >= startMinutes || timeMinutes <= endMinutes;
    } else {
      return timeMinutes >= startMinutes && timeMinutes <= endMinutes;
    }
  }
  
  // Helper method to convert time string to minutes
  timeToMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Whether `candidate` overlaps, or leaves less than min_rest_hours between it and, any of
   * `otherShifts`. Uses real start/end instants, so overnight shifts and shifts on either
   * side of the candidate are handled. 1-to-1 shifts may sit on top of background shifts.
   */
  violatesRestOrOverlap(candidate, otherShifts) {
    const minRest = this.settings.min_rest_hours;
    const candidateKey = shiftKeyOf(candidate);
    const shape = (s) => ({ date: shiftDateYmd(s), start_time: s.start_time, end_time: s.end_time });
    const candidateShape = shape(candidate);
    for (const other of otherShifts) {
      if (shiftKeyOf(other) === candidateKey || isOneToOne(other)) continue;
      const rest = restHoursBetween(shape(other), candidateShape);
      // Negative rest = the shifts overlap.
      if (rest !== null && rest < minRest) return true;
    }
    return false;
  }

  // Check if staff member has overlapping shifts or insufficient rest periods
  checkForOverlappingShifts(staffId, currentShift, allShifts) {
    const staffIdStr = staffId.toString();
    const staffAssignedShifts = allShifts.filter(shift =>
      shift.assigned_staff && shift.assigned_staff.some(assignment =>
        assignment.user_id.toString() === staffIdStr
      )
    );
    return this.violatesRestOrOverlap(currentShift, staffAssignedShifts);
  }

  // Get list of violated constraints
  getViolatedConstraints(assignments) {
    const violations = [];
    
    // This would analyze assignments against all constraints
    // For now, return basic violations
    assignments.forEach(assignment => {
      if (assignment.assignments.length < assignment.shift.required_staff_count) {
        violations.push({
          type: 'min_staff_required',
          shift: assignment.shift.id,
          message: `Shift understaffed: ${assignment.assignments.length}/${assignment.shift.required_staff_count}`
        });
      }
    });
    
    return violations;
  }

  // Get employment type distribution summary
  getEmploymentTypeDistribution(assignments, staff) {
    const distribution = {
      fulltime: { total_hours: 0, staff_count: 0, average_hours: 0 },
      parttime: { total_hours: 0, staff_count: 0, average_hours: 0 },
      bank: { total_hours: 0, staff_count: 0, average_hours: 0 }
    };
    
    const staffHours = {};
    
    // Initialize staff hours
    staff.forEach(s => {
      staffHours[s._id.toString()] = 0;
    });
    
    // Calculate hours for each staff member
    assignments.forEach(assignment => {
      const shiftPaid = this.paidHours(assignment.shift);
      
      assignment.assignments.forEach(ass => {
        const staffId = ass.user_id.toString();
        if (staffHours[staffId] !== undefined) {
          staffHours[staffId] += shiftPaid;
        }
      });
    });
    
    // Group by employment type
    staff.forEach(s => {
      const hours = staffHours[s._id.toString()] || 0;
      const type = s.type;
      
      if (distribution[type]) {
        distribution[type].total_hours += hours;
        distribution[type].staff_count++;
      }
    });
    
    // Calculate averages
    Object.keys(distribution).forEach(type => {
      if (distribution[type].staff_count > 0) {
        distribution[type].average_hours = distribution[type].total_hours / distribution[type].staff_count;
      }
    });
    
    return distribution;
  }

  // Apply the assignments to the database incrementally to prevent double-booking
  async applyAssignmentsToDatabaseIncrementally(assignments) {
    try {
      // Sort assignments by date and time to process them chronologically
      const sortedAssignments = assignments.sort((a, b) => {
        if (a.shift.date !== b.shift.date) {
          return a.shift.date.localeCompare(b.shift.date);
        }
        return a.shift.start_time.localeCompare(b.shift.start_time);
      });
      
      for (const assignment of sortedAssignments) {
        const shift = assignment.shift;
        const shiftId = shift._id || shift.id;
        
        // Find the shift in the database
        const existingShift = await Shift.findById(shiftId);
        
        if (!existingShift) {
          console.warn(`AI Solver: Shift with ID ${shiftId} not found in database. Skipping assignment.`);
          continue;
        }

        // Get current assignments for this shift
        const currentAssignedStaff = existingShift.assigned_staff || [];
        
        // Process each new assignment for this shift
        for (const ass of assignment.assignments) {
          // Check if staff member is already assigned to this shift
          const isAlreadyAssigned = currentAssignedStaff.some(existing => 
            existing.user_id.toString() === ass.user_id.toString()
          );
          
          if (!isAlreadyAssigned) {
            // Check for overlapping shifts before adding
            const hasOverlap = await this.checkForOverlappingShiftsInDatabase(
              ass.user_id,
              existingShift,
              existingShift.date
            );
            
            if (!hasOverlap) {
              currentAssignedStaff.push({
                user_id: ass.user_id,
                status: ass.status || 'assigned',
                assigned_at: new Date(),
                note: `AI Generated - Score: ${ass.score || 100}`
              });
            } else {
              console.warn(`AI Solver: Skipping assignment of ${ass.user_id} to shift ${shiftId} due to overlap`);
            }
          }
        }

        // Update the shift document
        existingShift.assigned_staff = currentAssignedStaff;
        existingShift.status = currentAssignedStaff.length >= existingShift.required_staff_count ? 'fully_staffed' : 'understaffed';
        
        await existingShift.save();
      }
    } catch (error) {
      console.error('AI Solver: Error applying assignments to database:', error);
      throw new Error('Failed to apply assignments to database');
    }
  }

  // Check for overlapping shifts and insufficient rest periods in the database
  async checkForOverlappingShiftsInDatabase(staffId, currentShift, currentDate) {
    // Rest is at most 24h, so only shifts within two days either side can conflict.
    const nearbyShifts = await Shift.find({
      'assigned_staff.user_id': staffId.toString(),
      _id: { $ne: currentShift._id },
      date: { $gte: addDaysYmd(currentDate, -2), $lte: addDaysYmd(currentDate, 2) }
    }).select('date start_time end_time shift_type');
    return this.violatesRestOrOverlap(currentShift, nearbyShifts);
  }

  // Helper method to calculate shift duration in hours
  calculateShiftDuration(startTime, endTime) {
    const startMinutes = this.timeToMinutes(startTime);
    const endMinutes = this.timeToMinutes(endTime);

    let durationMinutes;
    if (endMinutes < startMinutes) {
      // Overnight shift
      durationMinutes = (24 * 60) - startMinutes + endMinutes;
    } else {
      durationMinutes = endMinutes - startMinutes;
    }
    
    return durationMinutes / 60; // Convert to hours
  }

  // Get employment type priority score (higher ranks first)
  getEmploymentTypePriority(type, projectedHours) {
    const rule = this.settings.hours[type];
    const tiers = PRIORITY_TIERS[type];
    if (!rule || !tiers) return 0;
    if (projectedHours < rule.target_min) return tiers[0];
    if (projectedHours <= rule.priority_soft_max) return tiers[1];
    if (projectedHours <= rule.hard_max) return tiers[2];
    return tiers[3];
  }
}

module.exports = AISolver;
module.exports.AUTO_ASSIGNABLE_ROLES = AUTO_ASSIGNABLE_ROLES;
