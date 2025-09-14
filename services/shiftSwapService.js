const Shift = require('../models/Shift');
const User = require('../models/User');
const TimeOffRequest = require('../models/TimeOffRequest');
const ShiftSwap = require('../models/ShiftSwap');

class ShiftSwapService {
  /**
   * Check if a shift swap would create conflicts for either user
   * @param {string} requesterShiftId - ID of the shift the requester wants to give up
   * @param {string} targetShiftId - ID of the shift the requester wants to receive
   * @param {string} requesterId - ID of the user requesting the swap
   * @param {string} targetUserId - ID of the user who would receive the requester's shift
   * @param {string} excludeSwapId - Swap ID to exclude from conflict check (for approval)
   * @returns {Object} Conflict check results
   */
  async checkSwapConflicts(requesterShiftId, targetShiftId, requesterId, targetUserId, excludeSwapId = null) {
    try {
      // Get the shifts involved in the swap
      const [requesterShift, targetShift] = await Promise.all([
        Shift.findById(requesterShiftId),
        Shift.findById(targetShiftId)
      ]);

      if (!requesterShift || !targetShift) {
        return {
          hasConflict: true,
          conflicts: [{
            type: 'shift_not_found',
            message: 'One or both shifts not found'
          }]
        };
      }

      // Get user information
      const [requester, targetUser] = await Promise.all([
        User.findById(requesterId),
        User.findById(targetUserId)
      ]);

      if (!requester || !targetUser) {
        return {
          hasConflict: true,
          conflicts: [{
            type: 'user_not_found',
            message: 'One or both users not found'
          }]
        };
      }

      const conflicts = [];

      // Check 1: Verify both users are assigned to their respective shifts
      const requesterAssigned = requesterShift.assigned_staff.some(
        assignment => assignment.user_id.toString() === requesterId
      );
      const targetUserAssigned = targetShift.assigned_staff.some(
        assignment => assignment.user_id.toString() === targetUserId
      );

      if (!requesterAssigned) {
        conflicts.push({
          type: 'assignment_mismatch',
          message: 'Requester is not assigned to the shift they want to give up'
        });
      }

      if (!targetUserAssigned) {
        conflicts.push({
          type: 'assignment_mismatch',
          message: 'Target user is not assigned to the shift they would give up'
        });
      }

      // Check 2: Verify both shifts are in the same home (or compatible homes)
      if (requesterShift.home_id.toString() !== targetShift.home_id.toString()) {
        // Check if users have access to both homes
        const requesterHomeIds = requester.homes?.map(h => h.home_id.toString()) || [];
        const targetUserHomeIds = targetUser.homes?.map(h => h.home_id.toString()) || [];

        if (!requesterHomeIds.includes(targetShift.home_id.toString())) {
          conflicts.push({
            type: 'home_access',
            message: 'Requester does not have access to the target shift\'s home'
          });
        }

        if (!targetUserHomeIds.includes(requesterShift.home_id.toString())) {
          conflicts.push({
            type: 'home_access',
            message: 'Target user does not have access to the requester\'s shift home'
          });
        }
      }

      // Check 3: Check for time conflicts after the swap
      const requesterConflicts = await this.checkTimeConflictsForUser(
        requesterId, 
        targetShift.date, 
        targetShift.start_time, 
        targetShift.end_time,
        requesterShiftId // Exclude the shift being given up
      );

      const targetUserConflicts = await this.checkTimeConflictsForUser(
        targetUserId, 
        requesterShift.date, 
        requesterShift.start_time, 
        requesterShift.end_time,
        targetShiftId // Exclude the shift being given up
      );

      conflicts.push(...requesterConflicts.map(c => ({ ...c, user: 'requester' })));
      conflicts.push(...targetUserConflicts.map(c => ({ ...c, user: 'target_user' })));

      // Check 4: Check for time-off conflicts
      const requesterTimeOffConflicts = await this.checkTimeOffConflicts(
        requesterId,
        targetShift.date
      );

      const targetUserTimeOffConflicts = await this.checkTimeOffConflicts(
        targetUserId,
        requesterShift.date
      );

      conflicts.push(...requesterTimeOffConflicts.map(c => ({ ...c, user: 'requester' })));
      conflicts.push(...targetUserTimeOffConflicts.map(c => ({ ...c, user: 'target_user' })));

      // Check 5: Check for existing pending swap requests
      const existingSwaps = await this.checkExistingSwapRequests(
        requesterShiftId, 
        targetShiftId, 
        requesterId, 
        targetUserId,
        excludeSwapId
      );

      conflicts.push(...existingSwaps);

      return {
        hasConflict: conflicts.length > 0,
        conflicts
      };

    } catch (error) {
      console.error('Error checking swap conflicts:', error);
      return {
        hasConflict: true,
        conflicts: [{
          type: 'system_error',
          message: 'Error occurred while checking conflicts'
        }]
      };
    }
  }

  /**
   * Check for time conflicts for a user on a specific date/time
   * @param {string} userId - User ID
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {string} startTime - Start time in HH:MM format
   * @param {string} endTime - End time in HH:MM format
   * @param {string} excludeShiftId - Shift ID to exclude from conflict check
   * @returns {Array} Array of conflicts
   */
  async checkTimeConflictsForUser(userId, date, startTime, endTime, excludeShiftId = null) {
    try {
      const conflicts = [];

      // Find all shifts the user is assigned to on the same date
      const userShifts = await Shift.find({
        date: date,
        'assigned_staff.user_id': userId,
        is_active: true
      });

      // Filter out the excluded shift
      const relevantShifts = userShifts.filter(shift => 
        !excludeShiftId || shift._id.toString() !== excludeShiftId
      );

      // Check for overlapping shifts
      for (const shift of relevantShifts) {
        if (this.shiftsOverlap(startTime, endTime, shift.start_time, shift.end_time)) {
          conflicts.push({
            type: 'time_overlap',
            message: `Overlaps with existing shift: ${shift.start_time} - ${shift.end_time}`,
            conflictingShiftId: shift._id
          });
        }
      }

      // Check for insufficient rest period between shifts
      for (const shift of relevantShifts) {
        const restPeriod = this.calculateRestPeriod(startTime, endTime, shift.start_time, shift.end_time);
        if (restPeriod < 11 * 60) { // 11 hours minimum rest period
          conflicts.push({
            type: 'insufficient_rest',
            message: `Insufficient rest period (${Math.round(restPeriod / 60)}h) with shift: ${shift.start_time} - ${shift.end_time}`,
            conflictingShiftId: shift._id,
            restPeriodMinutes: restPeriod
          });
        }
      }

      return conflicts;

    } catch (error) {
      console.error('Error checking time conflicts:', error);
      return [{
        type: 'system_error',
        message: 'Error occurred while checking time conflicts'
      }];
    }
  }

  /**
   * Check for time-off conflicts
   * @param {string} userId - User ID
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Array} Array of conflicts
   */
  async checkTimeOffConflicts(userId, date) {
    try {
      const conflicts = [];

      const timeOffRequest = await TimeOffRequest.findOne({
        user_id: userId,
        start_date: { $lte: date },
        end_date: { $gte: date },
        status: 'approved'
      });

      if (timeOffRequest) {
        conflicts.push({
          type: 'time_off_conflict',
          message: `User has approved time off on ${date}`,
          timeOffRequestId: timeOffRequest._id
        });
      }

      return conflicts;

    } catch (error) {
      console.error('Error checking time-off conflicts:', error);
      return [{
        type: 'system_error',
        message: 'Error occurred while checking time-off conflicts'
      }];
    }
  }

  /**
   * Check for existing swap requests that might conflict
   * @param {string} requesterShiftId - Requester's shift ID
   * @param {string} targetShiftId - Target shift ID
   * @param {string} requesterId - Requester user ID
   * @param {string} targetUserId - Target user ID
   * @param {string} excludeSwapId - Swap ID to exclude from conflict check (for approval)
   * @returns {Array} Array of conflicts
   */
  async checkExistingSwapRequests(requesterShiftId, targetShiftId, requesterId, targetUserId, excludeSwapId = null) {
    try {
      const conflicts = [];

      // Check for existing pending swaps involving these shifts
      const query = {
        status: 'pending',
        $or: [
          { requester_shift_id: requesterShiftId },
          { target_shift_id: requesterShiftId },
          { requester_shift_id: targetShiftId },
          { target_shift_id: targetShiftId }
        ]
      };

      // Exclude the current swap if provided (for approval scenarios)
      if (excludeSwapId) {
        query._id = { $ne: excludeSwapId };
      }

      const existingSwaps = await ShiftSwap.find(query);

      for (const swap of existingSwaps) {
        conflicts.push({
          type: 'existing_swap_request',
          message: 'One or both shifts are already involved in a pending swap request',
          existingSwapId: swap._id
        });
      }

      return conflicts;

    } catch (error) {
      console.error('Error checking existing swap requests:', error);
      return [{
        type: 'system_error',
        message: 'Error occurred while checking existing swap requests'
      }];
    }
  }

  /**
   * Execute a shift swap (reassign the shifts)
   * @param {string} swapId - Shift swap ID
   * @returns {Object} Result of the swap execution
   */
  async executeSwap(swapId) {
    try {
      const swap = await ShiftSwap.findById(swapId)
        .populate('requester_shift_id target_shift_id requester_id target_user_id');

      if (!swap) {
        throw new Error('Shift swap not found');
      }

      if (swap.status !== 'approved') {
        throw new Error('Only approved swaps can be executed');
      }

      const requesterShift = swap.requester_shift_id;
      const targetShift = swap.target_shift_id;
      const requesterId = swap.requester_id._id.toString();
      const targetUserId = swap.target_user_id._id.toString();

      // Remove requester from their current shift
      requesterShift.assigned_staff = requesterShift.assigned_staff.filter(
        assignment => assignment.user_id.toString() !== requesterId
      );

      // Remove target user from their current shift
      targetShift.assigned_staff = targetShift.assigned_staff.filter(
        assignment => assignment.user_id.toString() !== targetUserId
      );

      // Add requester to target shift
      targetShift.assigned_staff.push({
        user_id: requesterId,
        status: 'assigned',
        assigned_at: new Date(),
        note: `Assigned via shift swap (ID: ${swapId})`
      });

      // Add target user to requester's shift
      requesterShift.assigned_staff.push({
        user_id: targetUserId,
        status: 'assigned',
        assigned_at: new Date(),
        note: `Assigned via shift swap (ID: ${swapId})`
      });

      // Save both shifts
      await Promise.all([
        requesterShift.save(),
        targetShift.save()
      ]);

      // Mark swap as completed
      swap.complete();
      await swap.save();

      return {
        success: true,
        message: 'Shift swap executed successfully',
        swapId: swap._id,
        requesterShiftId: requesterShift._id,
        targetShiftId: targetShift._id
      };

    } catch (error) {
      console.error('Error executing shift swap:', error);
      throw error;
    }
  }

  /**
   * Check if two shifts overlap in time
   * @param {string} start1 - Start time of first shift
   * @param {string} end1 - End time of first shift
   * @param {string} start2 - Start time of second shift
   * @param {string} end2 - End time of second shift
   * @returns {boolean} True if shifts overlap
   */
  shiftsOverlap(start1, end1, start2, end2) {
    const start1Minutes = this.timeToMinutes(start1);
    const end1Minutes = this.timeToMinutes(end1);
    const start2Minutes = this.timeToMinutes(start2);
    const end2Minutes = this.timeToMinutes(end2);

    // Handle overnight shifts
    const end1Adjusted = end1Minutes < start1Minutes ? end1Minutes + 24 * 60 : end1Minutes;
    const end2Adjusted = end2Minutes < start2Minutes ? end2Minutes + 24 * 60 : end2Minutes;

    return !(end1Adjusted <= start2Minutes || start1Minutes >= end2Adjusted);
  }

  /**
   * Calculate rest period between two shifts
   * @param {string} end1 - End time of first shift
   * @param {string} start2 - Start time of second shift
   * @returns {number} Rest period in minutes
   */
  calculateRestPeriod(start1, end1, start2, end2) {
    const end1Minutes = this.timeToMinutes(end1);
    const start2Minutes = this.timeToMinutes(start2);

    // Handle overnight shifts
    const end1Adjusted = end1Minutes < this.timeToMinutes(start1) ? end1Minutes + 24 * 60 : end1Minutes;
    const start2Adjusted = start2Minutes < this.timeToMinutes(start2) ? start2Minutes + 24 * 60 : start2Minutes;

    return start2Adjusted - end1Adjusted;
  }

  /**
   * Convert time string to minutes since midnight
   * @param {string} time - Time in HH:MM format
   * @returns {number} Minutes since midnight
   */
  timeToMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }
}

module.exports = new ShiftSwapService();
