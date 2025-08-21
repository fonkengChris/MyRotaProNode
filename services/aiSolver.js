const { ConstraintWeights } = require('../models/ConstraintWeights');
const { User } = require('../models/User');
const { Shift } = require('../models/Shift');
const { Availability } = require('../models/Availability');
const { TimeOffRequest } = require('../models/TimeOffRequest');

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
      const context = { home_id: homeId, service_id: serviceId };
      this.weights = await ConstraintWeights.getConstraintsForContext(context);
      
      return true;
    } catch (error) {
      console.error('AI Solver initialization error:', error);
      throw new Error('Failed to initialize AI solver');
    }
  }

  // Main method to generate rota assignments
  async generateRota(weekStartDate, weekEndDate, homeId, serviceId, existingShifts = []) {
    try {
      await this.initialize(homeId, serviceId);
      
      // Get all available staff for the home
      const staff = await User.find({ 
        home_id: homeId, 
        is_active: true 
      }).select('_id name skills preferred_shift_types max_hours_per_week');
      
      if (staff.length === 0) {
        throw new Error('No staff available for this home');
      }

      // Get availability data for the week
      const availabilityData = await this.getAvailabilityData(staff.map(s => s._id), weekStartDate, weekEndDate);
      
      // Get time off requests for the week
      const timeOffData = await this.getTimeOffData(staff.map(s => s._id), weekStartDate, weekEndDate);
      
      // Generate shifts if none exist
      let shifts = existingShifts;
      if (shifts.length === 0) {
        shifts = await this.generateDefaultShifts(weekStartDate, weekEndDate, serviceId);
      }
      
      // Solve assignment problem
      const assignments = await this.solveAssignmentProblem(shifts, staff, availabilityData, timeOffData);
      
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
      const availability = await Availability.find({
        user_id: { $in: staffIds },
        date: { $gte: startDate, $lte: endDate }
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

  // Generate default shifts for the week
  async generateDefaultShifts(startDate, endDate, serviceId) {
    const shifts = [];
    const currentDate = new Date(startDate);
    
    while (currentDate <= new Date(endDate)) {
      // Morning shift: 7:00 - 15:00
      shifts.push({
        date: new Date(currentDate),
        start_time: '07:00',
        end_time: '15:00',
        shift_type: 'morning',
        required_staff_count: 2
      });
      
      // Afternoon shift: 15:00 - 23:00
      shifts.push({
        date: new Date(currentDate),
        start_time: '15:00',
        end_time: '23:00',
        shift_type: 'afternoon',
        required_staff_count: 2
      });
      
      // Night shift: 23:00 - 07:00 (next day)
      shifts.push({
        date: new Date(currentDate),
        start_time: '23:00',
        end_time: '07:00',
        shift_type: 'night',
        required_staff_count: 1
      });
      
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return shifts;
  }

  // Solve the assignment problem using constraint optimization
  async solveAssignmentProblem(shifts, staff, availabilityData, timeOffData) {
    try {
      // Build constraint matrix
      const constraints = this.buildConstraintMatrix(shifts, staff, availabilityData, timeOffData);
      
      // Use greedy algorithm for initial assignment
      const assignments = this.greedyAssignment(shifts, staff, constraints);
      
      // Apply local search optimization
      const optimizedAssignments = this.localSearchOptimization(assignments, constraints);
      
      return optimizedAssignments;
      
    } catch (error) {
      console.error('Assignment problem solving error:', error);
      throw new Error('Failed to solve assignment problem');
    }
  }

  // Build constraint matrix for all staff-shift combinations
  buildConstraintMatrix(shifts, staff, availabilityData, timeOffData) {
    const constraints = {};
    
    staff.forEach(staffMember => {
      constraints[staffMember._id] = {};
      
      shifts.forEach(shift => {
        const shiftDate = shift.date.toISOString().split('T')[0];
        
        // Check availability
        const availability = availabilityData.find(av => 
          av.user_id.toString() === staffMember._id.toString() && 
          av.date === shiftDate
        );
        
        // Check time off
        const timeOff = timeOffData.find(to => 
          to.user_id.toString() === staffMember._id.toString() && 
          to.isActive(shiftDate)
        );
        
        // Calculate constraint score
        let score = 100; // Base score
        
        if (!availability || !availability.is_available) {
          score = 0; // Not available
        } else if (timeOff) {
          score = 0; // Time off approved
        } else {
          // Apply soft constraints
          if (availability.preferred_shift_types && 
              availability.preferred_shift_types.length > 0 &&
              !availability.prefersShiftType(shift.shift_type)) {
            score -= 30;
          }
          
          if (availability.preferred_start_time && 
              availability.preferred_end_time &&
              !availability.prefersTimeRange(shift.start_time, shift.end_time)) {
            score -= 20;
          }
        }
        
        constraints[staffMember._id][shift.id || `${shift.date}-${shift.start_time}`] = Math.max(score, 0);
      });
    });
    
    return constraints;
  }

  // Greedy assignment algorithm
  greedyAssignment(shifts, staff, constraints) {
    const assignments = [];
    const assignedStaff = new Set();
    
    shifts.forEach(shift => {
      const shiftId = shift.id || `${shift.date}-${shift.start_time}`;
      const shiftAssignments = [];
      
      // Sort staff by constraint score for this shift
      const staffScores = staff
        .filter(s => !assignedStaff.has(s._id.toString()))
        .map(s => ({
          staffId: s._id,
          score: constraints[s._id][shiftId] || 0
        }))
        .sort((a, b) => b.score - a.score);
      
      // Assign required number of staff
      for (let i = 0; i < shift.required_staff_count && i < staffScores.length; i++) {
        if (staffScores[i].score > 0) {
          shiftAssignments.push({
            shift_id: shiftId,
            user_id: staffScores[i].staffId,
            status: 'assigned',
            score: staffScores[i].score
          });
          assignedStaff.add(staffScores[i].staffId.toString());
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
}

module.exports = AISolver;
