const ConstraintWeights = require('../models/ConstraintWeights');
const User = require('../models/User');
const Shift = require('../models/Shift');
const Availability = require('../models/Availability');
const TimeOffRequest = require('../models/TimeOffRequest');

class AISolver {
  constructor() {
    this.constraints = null;
    this.weights = null;
  }

  // Initialize solver with constraints and weights
  async initialize(homeId, serviceId) {
    try {
      // Load constraint weights
      this.constraints = await ConstraintWeights.getActiveConstraints();
      
      // Load context-specific constraints
      const context = { 
        home_id: homeId, 
        service_id: serviceId,
        // Add additional context properties that appliesToContext might need
        user_homes: [{ home_id: homeId }],
        user_role: 'admin' // Default role for system-level constraints
      };
      this.weights = await ConstraintWeights.getConstraintsForContext(context);
      
      return true;
    } catch (error) {
      console.error('AI Solver initialization error:', error);
      throw new Error('Failed to initialize AI solver');
    }
  }

  // Main method to generate rota assignments
  async generateRota(weekStartDate, weekEndDate, homeIds, serviceId, existingShifts = []) {
    try {
      // Convert string dates to Date objects if needed
      const startDate = typeof weekStartDate === 'string' ? new Date(weekStartDate) : weekStartDate;
      const endDate = typeof weekEndDate === 'string' ? new Date(weekEndDate) : weekEndDate;
      
      // Ensure homeIds is always an array
      const homeIdArray = Array.isArray(homeIds) ? homeIds : [homeIds];
      
      // Initialize with the first home for constraints (can be enhanced later for multi-home constraints)
      await this.initialize(homeIdArray[0], serviceId);
      
      // Get all available staff for all specified homes
      const mongoose = require('mongoose');
      const homeIdObjs = homeIdArray.map(homeId => 
        typeof homeId === 'string' ? new mongoose.Types.ObjectId(homeId) : homeId
      );
      
      const staff = await User.find({ 
        'homes.home_id': { $in: homeIdObjs }, 
        is_active: true 
      }).select('_id name skills preferred_shift_types max_hours_per_week type homes');
      
      if (staff.length === 0) {
        throw new Error('No staff available for the specified homes');
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
        // Fetch shifts from ALL homes where staff members work (not just target homes)
        const Shift = require('../models/Shift');
        const allHomeIdObjs = Array.from(allStaffHomeIds).map(homeId => 
          typeof homeId === 'string' ? new mongoose.Types.ObjectId(homeId) : homeId
        );
        
        shifts = await Shift.find({
          home_id: { $in: allHomeIdObjs },
          date: { 
            $gte: startDate.toISOString().split('T')[0], 
            $lte: endDate.toISOString().split('T')[0] 
          }
        }).populate('service_id', 'name');
        
        console.log(`AI Solver: Found ${shifts.length} existing shifts across all staff homes for the week`);
        
        // Check if we need to create shifts from weekly schedules for target homes
        const targetHomeIds = new Set(homeIdArray.map(id => id.toString()));
        const homesWithShifts = new Set();
        
        // Group existing shifts by home
        shifts.forEach(shift => {
          const homeId = shift.home_id.toString();
          homesWithShifts.add(homeId);
        });
        
        // For each target home that doesn't have shifts, try to create them from weekly schedule
        for (const homeId of homeIdArray) {
          if (!homesWithShifts.has(homeId.toString())) {
            try {
              console.log(`AI Solver: Creating shifts from weekly schedule for target home ${homeId}...`);
              const generatedShifts = await this.generateShiftsFromWeeklySchedule(startDate, endDate, homeId, serviceId);
              
              // Convert generated shifts to actual database records
              for (const generatedShift of generatedShifts) {
                const shiftData = {
                  home_id: homeId,
                  service_id: generatedShift.service_id,
                  date: generatedShift.date.toISOString().split('T')[0],
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
              }
              
              console.log(`AI Solver: Created ${generatedShifts.length} shifts for target home ${homeId}`);
            } catch (error) {
              console.warn(`AI Solver: Failed to create shifts for target home ${homeId}: ${error.message}`);
              // Continue with other homes even if one fails
            }
          }
        }
        
        // Fetch all shifts again after creating new ones (including all staff homes)
        const newlyCreatedShifts = await Shift.find({
          home_id: { $in: allHomeIdObjs },
          date: { 
            $gte: startDate.toISOString().split('T')[0], 
            $lte: endDate.toISOString().split('T')[0] 
          }
        }).populate('service_id', 'name');
        
        if (newlyCreatedShifts.length > shifts.length) {
          shifts = newlyCreatedShifts;
          console.log(`AI Solver: Updated shifts count to ${shifts.length} after creating new shifts`);
        }
        
        // Check if we have shifts for the target homes
        const targetHomeShifts = shifts.filter(shift => 
          targetHomeIds.has(shift.home_id.toString())
        );
        
        if (targetHomeShifts.length === 0) {
          throw new Error('No shifts found or could be created for the specified target homes and week. Please create shifts or weekly schedules first before using AI generation.');
        }
      }
      
      // Solve assignment problem considering multi-home constraints
      const assignments = await this.solveMultiHomeAssignmentProblem(shifts, staff, availabilityData, timeOffData, homeIdArray);
      
      // Apply the assignments to the database incrementally to prevent double-booking
      const hasValidShiftIds = assignments.some(assignment => {
        const shiftId = assignment.shift._id || assignment.shift.id;
        return mongoose.Types.ObjectId.isValid(shiftId);
      });
      
      if (hasValidShiftIds) {
        await this.applyAssignmentsToDatabaseIncrementally(assignments);
      } else {
        console.log('AI Solver: Skipping database application - shifts appear to be test data');
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

  // Solve the assignment problem using constraint optimization
  async solveAssignmentProblem(shifts, staff, availabilityData, timeOffData) {
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
      
      // Build constraint matrix for unassigned shifts only
      const constraints = this.buildConstraintMatrix(shiftsNeedingStaff, staff, availabilityData, timeOffData);
      
      // Use greedy algorithm for initial assignment
      const newAssignments = this.greedyAssignment(shiftsNeedingStaff, staff, constraints);
      
      // Apply local search optimization
      const optimizedNewAssignments = this.localSearchOptimization(newAssignments, constraints);
      
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
      console.error('Assignment problem solving error:', error);
      throw new Error('Failed to solve assignment problem');
    }
  }

  // Solve the assignment problem using constraint optimization for multiple homes
  async solveMultiHomeAssignmentProblem(shifts, staff, availabilityData, timeOffData, homeIds) {
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
      
      // Build constraint matrix for unassigned shifts only, considering multi-home assignments
      const constraints = this.buildMultiHomeConstraintMatrix(shiftsNeedingStaff, staff, availabilityData, timeOffData, homeIds);
      
      // Use greedy algorithm for initial assignment with multi-home awareness
      const newAssignments = this.greedyMultiHomeAssignment(shiftsNeedingStaff, staff, constraints, homeIds);
      
      // Apply local search optimization
      const optimizedNewAssignments = this.localSearchOptimization(newAssignments, constraints);
      
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

  // Build constraint matrix for all staff-shift combinations
  buildConstraintMatrix(shifts, staff, availabilityData, timeOffData) {
    const constraints = {};
    
    // Calculate current hours for each staff member from existing assignments
    const staffCurrentHours = this.calculateStaffCurrentHours(shifts, staff);
    
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
        
        // Check if staff member is already assigned to this shift
        const isAlreadyAssigned = shift.assigned_staff && shift.assigned_staff.some(assignment => 
          assignment.user_id.toString() === staffMember._id.toString()
        );
        
        if (isAlreadyAssigned) {
          // Staff member is already assigned to this shift
          constraints[staffMember._id][shiftKey] = 0;
          return;
        }
        
        // Check for overlapping shifts (staff already assigned to shifts at the same time)
        const hasOverlappingShift = this.checkForOverlappingShifts(
          staffMember._id,
          shift,
          shifts,
          staffCurrentHours
        );
        
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
        
        // Check time off - note: isActive method might not exist
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
            score -= 30;
          }
          
          if (availability && availability.start_time && 
              availability.end_time &&
              !this.isTimeInRange(shift.start_time, availability.start_time, availability.end_time)) {
            score -= 20;
          }
          
          // Apply employment type constraints
          score = this.applyEmploymentTypeConstraints(
            score, 
            staffMember, 
            shift, 
            staffCurrentHours[staffMember._id.toString()] || 0
          );
        }
        
        const shiftKey = shift._id || shift.id || `${shiftDate}-${shift.start_time}`;
        constraints[staffMember._id][shiftKey] = Math.max(score, 0);
      });
    });
    
    return constraints;
  }

  // Build constraint matrix for all staff-shift combinations considering multi-home assignments
  buildMultiHomeConstraintMatrix(shifts, staff, availabilityData, timeOffData, homeIds) {
    const constraints = {};
    
    // Calculate current hours for each staff member from existing assignments across all homes
    const staffCurrentHours = this.calculateStaffCurrentHoursAcrossHomes(shifts, staff, homeIds);
    
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
        
        // Check if staff member has access to this shift's home
        const hasHomeAccess = staffMember.homes.some(home => 
          home.home_id.toString() === shift.home_id.toString()
        );
        
        if (!hasHomeAccess) {
          // Staff member doesn't have access to this home
          constraints[staffMember._id][`${shift._id || shift.id || `${shiftDate}-${shift.start_time}`}`] = 0;
          return;
        }
        
        // Check if staff member is already assigned to this shift
        const isAlreadyAssigned = shift.assigned_staff && shift.assigned_staff.some(assignment => 
          assignment.user_id.toString() === staffMember._id.toString()
        );
        
        if (isAlreadyAssigned) {
          // Staff member is already assigned to this shift
          constraints[staffMember._id][`${shift._id || shift.id || `${shiftDate}-${shift.start_time}`}`] = 0;
          return;
        }
        
        // Check for overlapping shifts (staff already assigned to shifts at the same time)
        const hasOverlappingShift = this.checkForOverlappingShifts(
          staffMember._id,
          shift,
          shifts,
          staffCurrentHours
        );
        
        if (hasOverlappingShift) {
          // Staff member has overlapping shifts
          constraints[staffMember._id][`${shift._id || shift.id || `${shiftDate}-${shift.start_time}`}`] = 0;
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
            score -= 30;
          }
          
          if (availability && availability.start_time && 
              availability.end_time &&
              !this.isTimeInRange(shift.start_time, availability.start_time, availability.end_time)) {
            score -= 20;
          }
          
          // Apply employment type constraints with multi-home awareness
          score = this.applyMultiHomeEmploymentTypeConstraints(
            score, 
            staffMember, 
            shift, 
            staffCurrentHours[staffMember._id.toString()] || 0,
            homeIds
          );
        }
        
        const shiftKey = shift._id || shift.id || `${shiftDate}-${shift.start_time}`;
        constraints[staffMember._id][shiftKey] = Math.max(score, 0);
      });
    });
    
    return constraints;
  }

  // Calculate current hours for each staff member from existing assignments
  calculateStaffCurrentHours(shifts, staff) {
    const staffHours = {};
    
    staff.forEach(staffMember => {
      staffHours[staffMember._id.toString()] = 0;
    });
    
    shifts.forEach(shift => {
      if (shift.assigned_staff && shift.assigned_staff.length > 0) {
        shift.assigned_staff.forEach(assignment => {
          const staffId = assignment.user_id.toString();
          if (staffHours[staffId] !== undefined) {
            // Calculate shift duration and add to staff hours
            const duration = this.calculateShiftDuration(shift.start_time, shift.end_time);
            staffHours[staffId] += duration;
          }
        });
      }
    });
    
    return staffHours;
  }

  // Calculate current hours for each staff member from existing assignments across multiple homes
  calculateStaffCurrentHoursAcrossHomes(shifts, staff, homeIds) {
    const staffHours = {};
    
    staff.forEach(staffMember => {
      staffHours[staffMember._id.toString()] = 0;
    });
    
    shifts.forEach(shift => {
      // Only count hours for shifts in the specified homes
      if (!homeIds.includes(shift.home_id.toString())) {
        return;
      }
      
      if (shift.assigned_staff && shift.assigned_staff.length > 0) {
        shift.assigned_staff.forEach(assignment => {
          const staffId = assignment.user_id.toString();
          if (staffHours[staffId] !== undefined) {
            // Calculate shift duration and add to staff hours
            const duration = this.calculateShiftDuration(shift.start_time, shift.end_time);
            staffHours[staffId] += duration;
          }
        });
      }
    });
    
    return staffHours;
  }

  // Apply employment type constraints to scoring
  applyEmploymentTypeConstraints(baseScore, staffMember, shift, currentHours) {
    let score = baseScore;
    const shiftDuration = this.calculateShiftDuration(shift.start_time, shift.end_time);
    const projectedHours = currentHours + shiftDuration;
    
    switch (staffMember.type) {
      case 'fulltime':
        // Full-time workers should have minimum 38 hours, but don't over-prioritize them
        if (projectedHours < 38) {
          // Prefer full-time workers who are below minimum hours, but not excessively
          score += 25;
        } else if (projectedHours <= 45) {
          // Good range for full-time workers
          score += 15;
        } else if (projectedHours > 50) {
          // Penalize excessive hours for full-time workers
          score -= 30;
        }
        break;
        
      case 'parttime':
        // Part-time workers should have maximum 24 hours, but prioritize them over bank workers
        if (projectedHours <= 24) {
          // Strongly prefer part-time workers over bank workers
          score += 30;
        } else if (projectedHours > 24) {
          // Strongly penalize exceeding part-time limits
          score -= 60;
        }
        break;
        
      case 'bank':
        // Bank workers should have minimal hours, maximum 20 hours, lowest priority
        if (projectedHours <= 15) {
          // Low priority for bank workers - only use when necessary
          score += 5;
        } else if (projectedHours > 20) {
          // Strongly penalize exceeding bank worker limits
          score -= 80;
        }
        break;
    }
    
    return score;
  }

  // Apply employment type constraints to scoring with multi-home awareness
  applyMultiHomeEmploymentTypeConstraints(baseScore, staffMember, shift, currentHours, homeIds) {
    let score = baseScore;
    const shiftDuration = this.calculateShiftDuration(shift.start_time, shift.end_time);
    const projectedHours = currentHours + shiftDuration;
    
    // Check if this is the staff member's default home
    const isDefaultHome = staffMember.homes.some(home => 
      home.home_id.toString() === shift.home_id.toString() && home.is_default
    );
    
    switch (staffMember.type) {
      case 'fulltime':
        // Full-time workers should have minimum 38 hours, but don't over-prioritize them
        if (projectedHours < 38) {
          // Prefer full-time workers who are below minimum hours, but not excessively
          score += 25;
        } else if (projectedHours <= 45) {
          // Good range for full-time workers
          score += 15;
        } else if (projectedHours > 50) {
          // Penalize excessive hours for full-time workers
          score -= 30;
        }
        
        // Bonus for default home assignments
        if (isDefaultHome) {
          score += 10;
        }
        break;
        
      case 'parttime':
        // Part-time workers should have maximum 24 hours, but prioritize them over bank workers
        if (projectedHours <= 24) {
          // Strongly prefer part-time workers over bank workers
          score += 30;
        } else if (projectedHours > 24) {
          // Strongly penalize exceeding part-time limits
          score -= 60;
        }
        
        // Bonus for default home assignments
        if (isDefaultHome) {
          score += 15;
        }
        break;
        
      case 'bank':
        // Bank workers should have minimal hours, maximum 20 hours, lowest priority
        if (projectedHours <= 15) {
          // Low priority for bank workers - only use when necessary
          score += 5;
        } else if (projectedHours > 20) {
          // Strongly penalize exceeding bank worker limits
          score -= 80;
        }
        
        // Small bonus for default home assignments
        if (isDefaultHome) {
          score += 5;
        }
        break;
    }
    
    return score;
  }

  // Greedy assignment algorithm with balanced distribution
  greedyAssignment(shifts, staff, constraints) {
    const assignments = [];
    const staffShiftCounts = {}; // Track how many shifts each staff member is assigned to
    const staffCurrentHours = {}; // Track current hours for each staff member
    
    // Initialize shift counts and hours for all staff
    staff.forEach(s => {
      staffShiftCounts[s._id.toString()] = 0;
      staffCurrentHours[s._id.toString()] = 0;
    });
    
    // Categorize staff by employment type
    const fulltimeStaff = staff.filter(s => s.type === 'fulltime');
    const parttimeStaff = staff.filter(s => s.type === 'parttime');
    const bankStaff = staff.filter(s => s.type === 'bank');
    
    // Calculate target distribution (aim for more balanced distribution)
    const totalShifts = shifts.reduce((sum, shift) => sum + shift.required_staff_count, 0);
    const targetFulltimeShifts = Math.min(totalShifts * 0.6, fulltimeStaff.length * 15); // 60% of shifts, max 15 per full-time worker
    const targetParttimeShifts = Math.min(totalShifts * 0.35, parttimeStaff.length * 12); // 35% of shifts, max 12 per part-time worker (24 hours)
    const targetBankShifts = totalShifts - targetFulltimeShifts - targetParttimeShifts; // Remaining shifts
    
    // console.log(`AI Solver: Target distribution - Full-time: ${targetFulltimeShifts}, Part-time: ${targetParttimeShifts}, Bank: ${targetBankShifts}`);
    
    // Sort shifts by priority (longer shifts first, then by time)
    const sortedShifts = [...shifts].sort((a, b) => {
      const durationA = this.calculateShiftDuration(a.start_time, a.end_time);
      const durationB = this.calculateShiftDuration(b.start_time, b.end_time);
      
      if (durationA !== durationB) {
        return durationB - durationA; // Longer shifts first
      }
      
      // If same duration, sort by start time
      return a.start_time.localeCompare(b.start_time);
    });
    
    let fulltimeShiftsAssigned = 0;
    let parttimeShiftsAssigned = 0;
    let bankShiftsAssigned = 0;
    
    sortedShifts.forEach((shift, index) => {
      const shiftId = shift._id || shift.id || `${shift.date}-${shift.start_time}`;
      const shiftAssignments = [];
      const shiftDuration = this.calculateShiftDuration(shift.start_time, shift.end_time);
      
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
      
      // console.log(`AI Solver: Shift ${index + 1} - Prioritized types: ${prioritizedTypes.join(', ')}`);
      // console.log(`AI Solver: Current counts - Full-time: ${fulltimeShiftsAssigned}, Part-time: ${parttimeShiftsAssigned}, Bank: ${bankShiftsAssigned}`);
      
      // Sort staff by prioritized types and constraint score
      const staffScores = staff
        .map(s => ({
          staffId: s._id,
          name: s.name,
          type: s.type,
          score: constraints[s._id] ? (constraints[s._id][shiftId] || 0) : 0,
          currentShifts: staffShiftCounts[s._id.toString()] || 0,
          currentHours: staffCurrentHours[s._id.toString()] || 0,
          projectedHours: (staffCurrentHours[s._id.toString()] || 0) + shiftDuration,
          typePriority: prioritizedTypes.indexOf(s.type) >= 0 ? prioritizedTypes.indexOf(s.type) : 999 // Not prioritized = very low priority
        }))
        .filter(s => s.score > 0) // Only consider available staff
      
            // console.log(`AI Solver: Available staff for shift ${index + 1}:`, staffScores.map(s => `${s.name} (${s.type}) - score: ${s.score}, typePriority: ${s.typePriority}`));
      
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
          const weightedScoreA = a.score + (a.type === 'parttime' ? 50 : 0); // Boost part-time workers
          const weightedScoreB = b.score + (b.type === 'parttime' ? 50 : 0); // Boost part-time workers
          
          if (weightedScoreA !== weightedScoreB) {
            return weightedScoreB - weightedScoreA;
          }
          
          // Quaternary sort by current hours (prefer staff with fewer hours within their type)
          return a.currentHours - b.currentHours;
        });
      
      // Assign required number of staff
      for (let i = 0; i < shift.required_staff_count && i < sortedStaffScores.length; i++) {
        const staffMember = sortedStaffScores[i];
        // console.log(`AI Solver: Assigning ${staffMember.name} (${staffMember.type}) to shift ${index + 1}`);
        
        shiftAssignments.push({
          shift_id: shiftId,
          user_id: staffMember.staffId,
          status: 'assigned',
          score: staffMember.score
        });
        
        // Update shift count and hours for this staff member
        staffShiftCounts[staffMember.staffId.toString()]++;
        staffCurrentHours[staffMember.staffId.toString()] += shiftDuration;
        
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
    
    // console.log(`AI Solver: Final distribution - Full-time: ${fulltimeShiftsAssigned}, Part-time: ${parttimeShiftsAssigned}, Bank: ${bankShiftsAssigned}`);
    
    return assignments;
  }

  // Greedy assignment algorithm with balanced distribution for multiple homes
  greedyMultiHomeAssignment(shifts, staff, constraints, homeIds) {
    const assignments = [];
    const staffShiftCounts = {}; // Track how many shifts each staff member is assigned to
    const staffCurrentHours = {}; // Track current hours for each staff member
    const staffHomeAssignments = {}; // Track assignments per home for each staff member
    
    // Initialize tracking for all staff
    staff.forEach(s => {
      staffShiftCounts[s._id.toString()] = 0;
      staffCurrentHours[s._id.toString()] = 0;
      staffHomeAssignments[s._id.toString()] = {};
      homeIds.forEach(homeId => {
        staffHomeAssignments[s._id.toString()][homeId] = 0;
      });
    });
    
    // Categorize staff by employment type
    const fulltimeStaff = staff.filter(s => s.type === 'fulltime');
    const parttimeStaff = staff.filter(s => s.type === 'parttime');
    const bankStaff = staff.filter(s => s.type === 'bank');
    
    // Calculate target distribution (aim for more balanced distribution)
    const totalShifts = shifts.reduce((sum, shift) => sum + shift.required_staff_count, 0);
    const targetFulltimeShifts = Math.min(totalShifts * 0.7, fulltimeStaff.length * 20); // 70% of shifts, max 20 per full-time worker
    const targetParttimeShifts = Math.min(totalShifts * 0.25, parttimeStaff.length * 8); // 25% of shifts, max 8 per part-time worker (16 hours)
    const targetBankShifts = totalShifts - targetFulltimeShifts - targetParttimeShifts; // Remaining shifts
    
    // Sort shifts by priority (longer shifts first, then by time)
    const sortedShifts = [...shifts].sort((a, b) => {
      const durationA = this.calculateShiftDuration(a.start_time, a.end_time);
      const durationB = this.calculateShiftDuration(b.start_time, b.end_time);
      
      if (durationA !== durationB) {
        return durationB - durationA; // Longer shifts first
      }
      
      // If same duration, sort by start time
      return a.start_time.localeCompare(b.start_time);
    });
    
    let fulltimeShiftsAssigned = 0;
    let parttimeShiftsAssigned = 0;
    let bankShiftsAssigned = 0;
    
    sortedShifts.forEach((shift, index) => {
      const shiftId = shift._id || shift.id || `${shift.date}-${shift.start_time}`;
      const shiftAssignments = [];
      const shiftDuration = this.calculateShiftDuration(shift.start_time, shift.end_time);
      const shiftHomeId = shift.home_id.toString();
      
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
          currentShifts: staffShiftCounts[s._id.toString()] || 0,
          currentHours: staffCurrentHours[s._id.toString()] || 0,
          projectedHours: (staffCurrentHours[s._id.toString()] || 0) + shiftDuration,
          typePriority: prioritizedTypes.indexOf(s.type) >= 0 ? prioritizedTypes.indexOf(s.type) : 999, // Not prioritized = very low priority
          homeAssignments: staffHomeAssignments[s._id.toString()][shiftHomeId] || 0,
          isDefaultHome: s.homes.some(home => home.home_id.toString() === shiftHomeId && home.is_default)
        }))
        .filter(s => s.score > 0) // Only consider available staff
        .filter(s => {
          // Apply strict hour limits based on employment type
          const maxHours = s.type === 'fulltime' ? 50 : s.type === 'parttime' ? 20 : 15;
          return s.projectedHours <= maxHours;
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
          const weightedScoreA = a.score + (a.isDefaultHome ? 20 : 0); // Boost default home workers
          const weightedScoreB = b.score + (b.isDefaultHome ? 20 : 0); // Boost default home workers
          
          if (weightedScoreA !== weightedScoreB) {
            return weightedScoreB - weightedScoreA;
          }
          
          // Quaternary sort by current hours (prefer staff with fewer hours within their type)
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
        staffShiftCounts[staffMember.staffId.toString()]++;
        staffCurrentHours[staffMember.staffId.toString()] += shiftDuration;
        staffHomeAssignments[staffMember.staffId.toString()][shiftHomeId]++;
        
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
  localSearchOptimization(assignments, constraints) {
    let improved = true;
    let iterations = 0;
    const maxIterations = 100;
    
    while (improved && iterations < maxIterations) {
      improved = false;
      iterations++;
      
      // Try to improve assignments by swapping staff between shifts
      for (let i = 0; i < assignments.length; i++) {
        for (let j = i + 1; j < assignments.length; j++) {
          const improvement = this.trySwap(assignments[i], assignments[j], constraints);
          if (improvement > 0) {
            improved = true;
          }
        }
      }
    }
    
    return assignments;
  }

  // Try to swap staff between two shifts
  trySwap(shift1, shift2, constraints) {
    let bestImprovement = 0;
    let bestSwap = null;
    
    shift1.assignments.forEach(assignment1 => {
      shift2.assignments.forEach(assignment2 => {
        // Calculate current score
        const currentScore = (constraints[assignment1.user_id][shift1.shift.id] || 0) +
                           (constraints[assignment2.user_id][shift2.shift.id] || 0);
        
        // Calculate score after swap
        const swappedScore = (constraints[assignment1.user_id][shift2.shift.id] || 0) +
                           (constraints[assignment2.user_id][shift1.shift.id] || 0);
        
        const improvement = swappedScore - currentScore;
        
        // Only allow swaps that improve employment type distribution
        if (improvement > bestImprovement) {
          // Additional check: ensure the swap doesn't violate employment type constraints
          const isValidSwap = this.validateEmploymentTypeSwap(
            assignment1, assignment2, shift1, shift2
          );
          
          if (isValidSwap) {
            bestImprovement = improvement;
            bestSwap = { assignment1, assignment2 };
          }
        }
      });
    });
    
    // Apply best swap if it improves the solution
    if (bestSwap && bestImprovement > 0) {
      const temp = bestSwap.assignment1.user_id;
      bestSwap.assignment1.user_id = bestSwap.assignment2.user_id;
      bestSwap.assignment2.user_id = temp;
      
      // Update scores
      bestSwap.assignment1.score = constraints[bestSwap.assignment1.user_id][shift1.shift.id] || 0;
      bestSwap.assignment2.score = constraints[bestSwap.assignment2.user_id][shift2.shift.id] || 0;
    }
    
    return bestImprovement;
  }

  // Validate that a swap doesn't violate employment type constraints
  validateEmploymentTypeSwap(assignment1, assignment2, shift1, shift2) {
    // This is a simplified validation - in a full implementation,
    // you would recalculate all hours for both staff members
    // For now, we'll allow the swap if both assignments exist
    return assignment1 && assignment2 && shift1 && shift2;
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

  // Check if staff member has overlapping shifts or insufficient rest periods
  checkForOverlappingShifts(staffId, currentShift, allShifts, staffCurrentHours) {
    const staffIdStr = staffId.toString();
    
    // Get all shifts where this staff member is already assigned
    const staffAssignedShifts = allShifts.filter(shift => 
      shift.assigned_staff && shift.assigned_staff.some(assignment => 
        assignment.user_id.toString() === staffIdStr
      )
    );
    
    // Check for overlaps and insufficient rest periods with the current shift
    for (const assignedShift of staffAssignedShifts) {
      // Skip if it's the same shift
      if (assignedShift._id.toString() === currentShift._id.toString()) {
        continue;
      }
      
      // Check for same date overlaps
      if (assignedShift.date === currentShift.date) {
        // Check for time overlap
        const start1 = new Date(`2000-01-01T${assignedShift.start_time}`);
        const end1 = new Date(`2000-01-01T${assignedShift.end_time}`);
        const start2 = new Date(`2000-01-01T${currentShift.start_time}`);
        const end2 = new Date(`2000-01-01T${currentShift.end_time}`);
        
        // Handle overnight shifts
        if (end1 < start1) end1.setDate(end1.getDate() + 1);
        if (end2 < start2) end2.setDate(end2.getDate() + 1);
        
        const overlaps = !(end1 <= start2 || end2 <= start1);
        
        if (overlaps) {
          return true; // Found an overlap
        }
      }
      
      // Check for insufficient rest periods (8-hour minimum gap required)
      const restPeriod = this.calculateRestPeriod(assignedShift, currentShift);
      if (restPeriod < 8) {
        return true; // Insufficient rest period
      }
    }
    
    return false; // No overlaps or rest period violations found
  }

  // Calculate rest period between two shifts in hours
  calculateRestPeriod(shift1, shift2) {
    // Convert dates to Date objects for comparison
    const date1 = new Date(shift1.date);
    const date2 = new Date(shift2.date);
    
    // Calculate the end time of the first shift
    const end1 = new Date(`2000-01-01T${shift1.end_time}`);
    const start2 = new Date(`2000-01-01T${shift2.start_time}`);
    
    // Handle overnight shifts
    if (end1.getHours() < start2.getHours()) {
      end1.setDate(end1.getDate() + 1);
    }
    
    // Calculate the start time of the second shift
    const start2Adjusted = new Date(`2000-01-01T${shift2.start_time}`);
    
    // If shifts are on different days, add the day difference
    const dayDiff = (date2 - date1) / (1000 * 60 * 60 * 24);
    start2Adjusted.setDate(start2Adjusted.getDate() + dayDiff);
    
    // Calculate rest period in hours
    const restPeriodMs = start2Adjusted.getTime() - end1.getTime();
    const restPeriodHours = restPeriodMs / (1000 * 60 * 60);
    
    return Math.abs(restPeriodHours);
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
      const shiftDuration = this.calculateShiftDuration(assignment.shift.start_time, assignment.shift.end_time);
      
      assignment.assignments.forEach(ass => {
        const staffId = ass.user_id.toString();
        if (staffHours[staffId] !== undefined) {
          staffHours[staffId] += shiftDuration;
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
    const staffIdStr = staffId.toString();
    
    // Find all shifts where this staff member is already assigned (across all dates)
    const overlappingShifts = await Shift.find({
      'assigned_staff.user_id': staffIdStr,
      _id: { $ne: currentShift._id } // Exclude current shift
    });
    
    for (const shift of overlappingShifts) {
      // Check for same date overlaps
      if (shift.date === currentDate) {
        // Check for time overlap
        const start1 = new Date(`2000-01-01T${shift.start_time}`);
        const end1 = new Date(`2000-01-01T${shift.end_time}`);
        const start2 = new Date(`2000-01-01T${currentShift.start_time}`);
        const end2 = new Date(`2000-01-01T${currentShift.end_time}`);
        
        // Handle overnight shifts
        if (end1 < start1) end1.setDate(end1.getDate() + 1);
        if (end2 < start2) end2.setDate(end2.getDate() + 1);
        
        const overlaps = !(end1 <= start2 || end2 <= start1);
        
        if (overlaps) {
          return true; // Found an overlap
        }
      }
      
      // Check for insufficient rest periods (8-hour minimum gap required)
      const restPeriod = this.calculateRestPeriod(shift, currentShift);
      if (restPeriod < 8) {
        return true; // Insufficient rest period
      }
    }
    
    return false; // No overlaps or rest period violations found
  }

  // Apply the assignments to the database (legacy method)
  async applyAssignmentsToDatabase(assignments) {
    try {
      for (const assignment of assignments) {
        const shift = assignment.shift;
        const shiftId = shift._id || shift.id;
        
        // Find the shift in the database
        const existingShift = await Shift.findById(shiftId);
        
        if (!existingShift) {
          console.warn(`AI Solver: Shift with ID ${shiftId} not found in database. Skipping assignment.`);
          continue;
        }

        // Clear existing assignments and add new ones
        const newAssignedStaff = [];
        
        // Process each assignment for this shift
        assignment.assignments.forEach(ass => {
          newAssignedStaff.push({
            user_id: ass.user_id,
            status: ass.status || 'assigned',
            assigned_at: new Date(),
            note: `AI Generated - Score: ${ass.score || 100}`
          });
        });

        // Update the shift document
        existingShift.assigned_staff = newAssignedStaff;
        existingShift.status = newAssignedStaff.length >= existingShift.required_staff_count ? 'fully_staffed' : 'understaffed';
        
        await existingShift.save();
      }
    } catch (error) {
      console.error('AI Solver: Error applying assignments to database:', error);
      throw new Error('Failed to apply assignments to database');
    }
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

  // Get employment type priority score
  getEmploymentTypePriority(type, projectedHours) {
    switch (type) {
      case 'fulltime':
        // Full-time workers get highest priority when below minimum hours
        if (projectedHours < 38) {
          return 100; // Highest priority
        } else if (projectedHours <= 45) {
          return 80; // Good priority
        } else if (projectedHours <= 50) {
          return 60; // Lower priority when approaching max
        } else {
          return 20; // Very low priority when over max
        }
        
      case 'parttime':
        // Part-time workers get moderate priority when within strict limits
        if (projectedHours <= 16) {
          return 60; // Moderate priority within limits
        } else if (projectedHours <= 20) {
          return 30; // Lower priority when approaching max
        } else {
          return 5; // Very low priority when over max
        }
        
      case 'bank':
        // Bank workers get lowest priority and only when within strict limits
        if (projectedHours <= 15) {
          return 25; // Low priority within strict limits
        } else if (projectedHours <= 20) {
          return 10; // Very low priority when approaching max
        } else {
          return 5; // Extremely low priority when over max
        }
        
      default:
        return 0;
    }
  }
}

module.exports = AISolver;
