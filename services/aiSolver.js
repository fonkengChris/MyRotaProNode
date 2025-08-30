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
      console.log('AI Solver: Starting initialization...');
      console.log('AI Solver: homeId:', homeId);
      console.log('AI Solver: serviceId:', serviceId);
      
      // Load constraint weights
      console.log('AI Solver: Loading active constraints...');
      this.constraints = await ConstraintWeights.getActiveConstraints();
      console.log('AI Solver: Active constraints loaded:', this.constraints.length);
      
      // Load context-specific constraints
      const context = { 
        home_id: homeId, 
        service_id: serviceId,
        // Add additional context properties that appliesToContext might need
        user_homes: [{ home_id: homeId }],
        user_role: 'admin' // Default role for system-level constraints
      };
      console.log('AI Solver: Loading context-specific constraints with context:', context);
      this.weights = await ConstraintWeights.getConstraintsForContext(context);
      console.log('AI Solver: Context-specific constraints loaded:', this.weights.length);
      
      console.log('AI Solver: Initialization completed successfully');
      return true;
    } catch (error) {
      console.error('AI Solver initialization error:', error);
      console.error('AI Solver initialization error stack:', error.stack);
      throw new Error('Failed to initialize AI solver');
    }
  }

  // Main method to generate rota assignments
  async generateRota(weekStartDate, weekEndDate, homeId, serviceId, existingShifts = []) {
    try {
      await this.initialize(homeId, serviceId);
      
      // Get all available staff for the home
      console.log('AI Solver: Querying for staff with home_id:', homeId);
      console.log('AI Solver: homeId type:', typeof homeId);
      
      // Convert string homeId to ObjectId if needed
      const mongoose = require('mongoose');
      const homeIdObj = typeof homeId === 'string' ? new mongoose.Types.ObjectId(homeId) : homeId;
      console.log('AI Solver: Converted homeId to ObjectId:', homeIdObj);
      
      const staff = await User.find({ 
        'homes.home_id': homeIdObj, 
        is_active: true 
      }).select('_id name skills preferred_shift_types max_hours_per_week');
      
      console.log('AI Solver: Staff query result:', staff.length, 'users found');
      if (staff.length > 0) {
        console.log('AI Solver: Sample staff member:', {
          id: staff[0]._id,
          name: staff[0].name,
          homes: staff[0].homes
        });
      }
      
      if (staff.length === 0) {
        throw new Error('No staff available for this home');
      }

      // Get availability data for the week
      const availabilityData = await this.getAvailabilityData(staff.map(s => s._id), weekStartDate, weekEndDate);
      
      // Get time off requests for the week
      const timeOffData = await this.getTimeOffData(staff.map(s => s._id), weekStartDate, weekEndDate);
      
      // Use existing shifts from rota grid instead of generating from weekly schedule
      let shifts = existingShifts;
      if (shifts.length === 0) {
        throw new Error('No shifts found in the rota grid. Please create shifts first before using AI generation.');
      }
      
      console.log('AI Solver: Using', shifts.length, 'existing shifts from rota grid');
      
      // Solve assignment problem
      const assignments = await this.solveAssignmentProblem(shifts, staff, availabilityData, timeOffData);
      
      // Apply the assignments to the database
      await this.applyAssignmentsToDatabase(assignments);
      
      return {
        success: true,
        assignments,
        total_penalty: this.calculateTotalPenalty(assignments),
        constraints_violated: this.getViolatedConstraints(assignments)
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
      
      console.log('AI Solver: Querying availability with date range:', startDateStr, 'to', endDateStr);
      
      const availability = await Availability.find({
        user_id: { $in: staffIds },
        date: { $gte: startDateStr, $lte: endDateStr }
      });
      
      console.log('AI Solver: Found availability records:', availability.length);
      if (availability.length > 0) {
        console.log('AI Solver: Sample availability record:', {
          user_id: availability[0].user_id,
          date: availability[0].date,
          is_available: availability[0].is_available
        });
      }
      
      return availability;                                                                                                                   
    } catch (error) {
      console.error('Error fetching availability data:', error);
      return [];
    }
  }

  // Get time off data for staff
  async getTimeOffData(staffIds, startDate, endDate) {
    try {
      const timeOff = await TimeOffRequest.find({
        user_id: { $in: staffIds },
        status: 'approved',
        start_date: { $lte: endDate },
        end_date: { $gte: startDate }
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
      console.log('AI Solver: Fetching weekly schedule for home:', homeId);
      
      // Import WeeklySchedule model
      const WeeklySchedule = require('../models/WeeklySchedule');
      
      // Fetch the home's weekly schedule
      const weeklySchedule = await WeeklySchedule.findOne({ home_id: homeId });
      
      if (!weeklySchedule) {
        throw new Error(`No weekly schedule found for home ${homeId}. Please create a weekly schedule for this home first.`);
      }
      
      console.log('AI Solver: Found weekly schedule:', weeklySchedule.schedule ? 'yes' : 'no');
      
      const shifts = [];
      const currentDate = new Date(startDate);
      
      // Day names for mapping
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      
      while (currentDate <= new Date(endDate)) {
        const dayName = dayNames[currentDate.getDay()];
        const daySchedule = weeklySchedule.schedule[dayName];
        
        if (daySchedule && daySchedule.is_active && daySchedule.shifts && daySchedule.shifts.length > 0) {
          console.log(`AI Solver: Processing ${dayName} with ${daySchedule.shifts.length} shifts`);
          
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
              console.log(`AI Solver: Created shift: ${shift.start_time}-${shift.end_time} (${shift.shift_type}) requiring ${shift.required_staff_count} staff`);
            }
          });
        } else {
          console.log(`AI Solver: No active schedule for ${dayName}`);
        }
        
        currentDate.setDate(currentDate.getDate() + 1);
      }
      
      if (shifts.length === 0) {
        throw new Error(`No shifts could be generated from the weekly schedule for home ${homeId}. Please check the weekly schedule configuration.`);
      }
      
      console.log('AI Solver: Generated', shifts.length, 'shifts from weekly schedule');
      return shifts;
      
    } catch (error) {
      console.error('AI Solver: Error generating shifts from weekly schedule:', error);
      throw new Error(`Failed to generate shifts from weekly schedule: ${error.message}`);
    }
  }

  // Solve the assignment problem using constraint optimization
  async solveAssignmentProblem(shifts, staff, availabilityData, timeOffData) {
    try {
      console.log('AI Solver: Starting assignment problem solving...');
      console.log('AI Solver: Shifts to assign:', shifts.length);
      console.log('AI Solver: Available staff:', staff.length);
      console.log('AI Solver: Availability data records:', availabilityData.length);
      console.log('AI Solver: Time off data records:', timeOffData.length);
      
      // Filter shifts to only include those that need staff assignment
      const shiftsNeedingStaff = shifts.filter(shift => {
        const currentAssignments = shift.assigned_staff || [];
        const requiredStaff = shift.required_staff_count || 1;
        return currentAssignments.length < requiredStaff;
      });
      
      console.log('AI Solver: Shifts needing staff assignment:', shiftsNeedingStaff.length);
      
      if (shiftsNeedingStaff.length === 0) {
        console.log('AI Solver: All shifts are already fully staffed');
        return shifts.map(shift => ({
          shift: shift,
          assignments: shift.assigned_staff || []
        }));
      }
      
      // Build constraint matrix for unassigned shifts only
      const constraints = this.buildConstraintMatrix(shiftsNeedingStaff, staff, availabilityData, timeOffData);
      console.log('AI Solver: Constraint matrix built, sample:', Object.keys(constraints).slice(0, 2).map(staffId => ({
        staffId,
        shiftCount: Object.keys(constraints[staffId]).length,
        sampleScores: Object.values(constraints[staffId]).slice(0, 3)
      })));
      
      // Use greedy algorithm for initial assignment
      const newAssignments = this.greedyAssignment(shiftsNeedingStaff, staff, constraints);
      console.log('AI Solver: Greedy assignment completed, new assignments:', newAssignments.length);
      
      // Apply local search optimization
      const optimizedNewAssignments = this.localSearchOptimization(newAssignments, constraints);
      console.log('AI Solver: Optimization completed');
      
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

  // Build constraint matrix for all staff-shift combinations
  buildConstraintMatrix(shifts, staff, availabilityData, timeOffData) {
    const constraints = {};
    
    console.log('AI Solver: Building constraint matrix...');
    console.log('AI Solver: Staff members:', staff.length);
    console.log('AI Solver: Shifts to process:', shifts.length);
    
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
          console.log('AI Solver: Unknown shift date format:', shift.date, typeof shift.date);
          shiftDate = 'unknown';
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
          console.log(`AI Solver: Staff ${staffMember.name} has time off on ${shiftDate}`);
        } else if (availability && !availability.is_available) {
          score = 0; // Explicitly marked as unavailable
          console.log(`AI Solver: Staff ${staffMember.name} explicitly marked unavailable on ${shiftDate}`);
        } else {
          // Staff is available (either no record exists or explicitly marked as available)
          console.log(`AI Solver: Staff ${staffMember.name} available on ${shiftDate} (score: ${score})`);
          
          // Apply soft constraints if availability data exists
          if (availability && availability.preferred_shift_types && 
              availability.preferred_shift_types.length > 0 &&
              !availability.preferred_shift_types.includes(shift.shift_type)) {
            score -= 30;
            console.log(`AI Solver: Staff ${staffMember.name} prefers different shift type, score reduced to ${score}`);
          }
          
          if (availability && availability.start_time && 
              availability.end_time &&
              !this.isTimeInRange(shift.start_time, availability.start_time, availability.end_time)) {
            score -= 20;
            console.log(`AI Solver: Staff ${staffMember.name} prefers different time range, score reduced to ${score}`);
          }
        }
        
        const shiftKey = shift._id || shift.id || `${shiftDate}-${shift.start_time}`;
        constraints[staffMember._id][shiftKey] = Math.max(score, 0);
        
        if (score === 0) {
          console.log(`AI Solver: Staff ${staffMember.name} score 0 for shift ${shiftKey} on ${shiftDate}`);
        }
      });
    });
    
    console.log('AI Solver: Constraint matrix completed');
    return constraints;
  }

  // Greedy assignment algorithm
  greedyAssignment(shifts, staff, constraints) {
    const assignments = [];
    const staffShiftCounts = {}; // Track how many shifts each staff member is assigned to
    
    console.log('AI Solver: Starting greedy assignment...');
    
    // Initialize shift counts for all staff
    staff.forEach(s => {
      staffShiftCounts[s._id.toString()] = 0;
    });
    
    shifts.forEach((shift, index) => {
      const shiftId = shift._id || shift.id || `${shift.date}-${shift.start_time}`;
      const shiftAssignments = [];
      
      console.log(`AI Solver: Processing shift ${index + 1}/${shifts.length}:`, shiftId);
      
      // Sort staff by constraint score for this shift, but also consider current workload
      const staffScores = staff
        .map(s => ({
          staffId: s._id,
          name: s.name,
          score: constraints[s._id] ? (constraints[s._id][shiftId] || 0) : 0,
          currentShifts: staffShiftCounts[s._id.toString()] || 0
        }))
        .filter(s => s.score > 0) // Only consider available staff
        .sort((a, b) => {
          // Primary sort by score, secondary by current shift count (prefer less busy staff)
          if (a.score !== b.score) {
            return b.score - a.score;
          }
          return a.currentShifts - b.currentShifts;
        });
      
      console.log(`AI Solver: Available staff for shift ${shiftId}:`, staffScores.length);
      console.log(`AI Solver: Top 3 staff scores:`, staffScores.slice(0, 3));
      
      // Assign required number of staff
      for (let i = 0; i < shift.required_staff_count && i < staffScores.length; i++) {
        const staffMember = staffScores[i];
        shiftAssignments.push({
          shift_id: shiftId,
          user_id: staffMember.staffId,
          status: 'assigned',
          score: staffMember.score
        });
        
        // Update shift count for this staff member
        staffShiftCounts[staffMember.staffId.toString()]++;
        
        console.log(`AI Solver: Assigned ${staffMember.name} (score: ${staffMember.score}, total shifts: ${staffShiftCounts[staffMember.staffId.toString()]}) to shift ${shiftId}`);
      }
      
      if (shiftAssignments.length === 0) {
        console.log(`AI Solver: WARNING - No staff assigned to shift ${shiftId}`);
      }
      
      assignments.push({
        shift: shift,
        assignments: shiftAssignments
      });
    });
    
    console.log('AI Solver: Greedy assignment completed. Total assignments:', assignments.length);
    console.log('AI Solver: Staff shift distribution:', staffShiftCounts);
    
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
        
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestSwap = { assignment1, assignment2 };
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

  // Apply the assignments to the database
  async applyAssignmentsToDatabase(assignments) {
    try {
      console.log('AI Solver: Applying assignments to database...');
      
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
        console.log(`AI Solver: Shift ${shiftId} updated with ${newAssignedStaff.length} staff assignments.`);
      }
      
      console.log('AI Solver: All assignments applied successfully.');
    } catch (error) {
      console.error('AI Solver: Error applying assignments to database:', error);
      throw new Error('Failed to apply assignments to database');
    }
  }
}

module.exports = AISolver;
