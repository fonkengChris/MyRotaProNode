const TimeOffRequest = require('../models/TimeOffRequest');
const Shift = require('../models/Shift');
const User = require('../models/User');
const ConstraintWeights = require('../models/ConstraintWeights');
const { getShiftHourBreakdown } = require('../utils/shiftHours');

class SchedulingConflictService {
  /** Match Shift model / schema virtual for duration (handles overnight). */
  static _shiftDurationHours(startTime, endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    let startTotal = sh * 60 + sm;
    let endTotal = eh * 60 + em;
    if (endTotal < startTotal) endTotal += 24 * 60;
    return (endTotal - startTotal) / 60;
  }

  /** Monday–Sunday week containing `dateStr` (YYYY-MM-DD), using local calendar dates. */
  static _weekRangeMondayToSunday(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const day = date.getDay();
    const offsetFromMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(date);
    monday.setDate(date.getDate() - offsetFromMonday);
    const fmt = (dt) => {
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    };
    const endDate = new Date(monday);
    endDate.setDate(monday.getDate() + 6);
    return { start: fmt(monday), end: fmt(endDate) };
  }

  /**
   * Check if a user has time-off conflicts for a specific date range
   * @param {string} userId - The user ID to check
   * @param {string} startDate - Start date in YYYY-MM-DD format
   * @param {string} endDate - End date in YYYY-MM-DD format
   * @returns {Promise<Array>} Array of conflicting time-off requests
   */
  static async checkTimeOffConflicts(userId, startDate, endDate) {
    try {
      const conflicts = await TimeOffRequest.find({
        user_id: userId,
        status: 'approved',
        $or: [
          // Time-off overlaps with the shift period
          {
            start_date: { $lte: endDate },
            end_date: { $gte: startDate }
          },
          // Time-off completely contains the shift period
          {
            start_date: { $lte: startDate },
            end_date: { $gte: endDate }
          }
        ]
      });

      return conflicts;
    } catch (error) {
      console.error('Error checking time-off conflicts:', error);
      throw error;
    }
  }

  /**
   * Check if a shift assignment would create a conflict
   * @param {string} userId - The user ID to check
   * @param {string} shiftDate - Shift date in YYYY-MM-DD format
   * @param {string} shiftStartTime - Shift start time in HH:MM format
   * @param {string} shiftEndTime - Shift end time in HH:MM format
   * @param {object} [options]
   * @param {string} [options.requesterRole] - Role of user making the assignment (required to exceed full-time weekly cap)
   * @param {string} [options.shiftType] - shift_type of the shift being assigned (for paid-hours / sleep-in rules)
   * @returns {Promise<Object>} Conflict information
   */
  static async checkShiftAssignmentConflict(userId, shiftDate, shiftStartTime, shiftEndTime, options = {}) {
    const requesterRole = options.requesterRole;
    const shiftType = options.shiftType;
    try {
      // Check for time-off conflicts on the same date
      const timeOffConflicts = await this.checkTimeOffConflicts(userId, shiftDate, shiftDate);
      
      if (timeOffConflicts.length > 0) {
        return {
          hasConflict: true,
          conflictType: 'time_off',
          conflicts: timeOffConflicts,
          message: `User has approved time off on ${shiftDate}`
        };
      }

      // Check for overlapping shifts on the same date
      const overlappingShifts = await Shift.find({
        date: shiftDate,
        'assigned_staff.user_id': userId,
        $or: [
          // New shift overlaps with existing shift
          {
            start_time: { $lt: shiftEndTime },
            end_time: { $gt: shiftStartTime }
          }
        ]
      });

      if (overlappingShifts.length > 0) {
        return {
          hasConflict: true,
          conflictType: 'overlapping_shift',
          conflicts: overlappingShifts,
          message: `User already has overlapping shifts on ${shiftDate}`
        };
      }

      // Check for maximum hours per day/week violations
      const dailyShifts = await Shift.find({
        date: shiftDate,
        'assigned_staff.user_id': userId
      });

      const totalDailyHours = dailyShifts.reduce((total, shift) => {
        const start = new Date(`2000-01-01T${shift.start_time}`);
        const end = new Date(`2000-01-01T${shift.end_time}`);
        const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        return total + hours;
      }, 0);

      // Add the new shift hours
      const newShiftStart = new Date(`2000-01-01T${shiftStartTime}`);
      const newShiftEnd = new Date(`2000-01-01T${shiftEndTime}`);
      const newShiftHours = (newShiftEnd.getTime() - newShiftStart.getTime()) / (1000 * 60 * 60);
      const totalHours = totalDailyHours + newShiftHours;

      if (totalHours > 24) {
        return {
          hasConflict: true,
          conflictType: 'max_hours_exceeded',
          conflicts: [],
          message: `Total daily hours (${totalHours.toFixed(1)}) would exceed 24 hours`
        };
      }

      // Full-time staff: weekly cap (default 48h); exceeding requires admin or home_manager
      const staff = await User.findById(userId).select('type').lean();
      if (staff && staff.type === 'fulltime') {
        const policy = await ConstraintWeights.getFulltimeWeeklyHoursPolicy();
        const week = this._weekRangeMondayToSunday(shiftDate);
        const weekShifts = await Shift.find({
          date: { $gte: week.start, $lte: week.end },
          'assigned_staff.user_id': userId
        }).select('start_time end_time date shift_type');

        let weeklyHours = weekShifts.reduce(
          (sum, s) => sum + getShiftHourBreakdown(s).paid_work_hours,
          0
        );
        weeklyHours += getShiftHourBreakdown({
          start_time: shiftStartTime,
          end_time: shiftEndTime,
          shift_type: shiftType,
        }).paid_work_hours;

        if (!ConstraintWeights.canAuthorizeFulltimeOverWeeklyCap(requesterRole, weeklyHours, policy)) {
          return {
            hasConflict: true,
            conflictType: 'fulltime_weekly_cap_exceeded',
            conflicts: [],
            message: `Full-time weekly hours would be ${weeklyHours.toFixed(1)} (limit ${policy.capHours}). Only ${policy.approverRoles.join(' or ')} may assign above this limit`,
            details: {
              projected_weekly_hours: Math.round(weeklyHours * 10) / 10,
              cap_hours: policy.capHours,
              week_start: week.start,
              week_end: week.end
            }
          };
        }
      }

      return {
        hasConflict: false,
        conflictType: null,
        conflicts: [],
        message: 'No conflicts detected'
      };
    } catch (error) {
      console.error('Error checking shift assignment conflict:', error);
      throw error;
    }
  }

  /**
   * Get all conflicts for a specific date range and home
   * @param {string} homeId - The home ID to check
   * @param {string} startDate - Start date in YYYY-MM-DD format
   * @param {string} endDate - End date in YYYY-MM-DD format
   * @returns {Promise<Object>} Summary of all conflicts
   */
  static async getHomeConflicts(homeId, startDate, endDate) {
    try {
      // Get all shifts in the date range for the home
      const shifts = await Shift.find({
        home_id: homeId,
        date: { $gte: startDate, $lte: endDate }
      }).populate('assigned_staff.user_id', 'name email');

      // Get all approved time-off requests for staff in the home
      const timeOffRequests = await TimeOffRequest.find({
        status: 'approved',
        start_date: { $lte: endDate },
        end_date: { $gte: startDate }
      }).populate('user_id', 'name email homes');

      // Filter time-off requests for this home
      const homeTimeOffRequests = timeOffRequests.filter(
        request => request.user_id.homes && request.user_id.homes.some(home => home.home_id.toString() === homeId)
      );

      const conflicts = [];

      // Check each shift for conflicts
      for (const shift of shifts) {
        for (const assignment of shift.assigned_staff) {
          const userId = assignment.user_id;
          
          // Check time-off conflicts
          const timeOffConflicts = homeTimeOffRequests.filter(
            request => request.user_id._id.toString() === userId.toString() &&
                      request.start_date <= shift.date &&
                      request.end_date >= shift.date
          );

          if (timeOffConflicts.length > 0) {
            conflicts.push({
              type: 'time_off_conflict',
              shift: shift,
              user: userId,
              timeOffRequests: timeOffConflicts,
              message: `${userId.name} has approved time off on ${shift.date} but is assigned to a shift`
            });
          }
        }
      }

      return {
        totalConflicts: conflicts.length,
        conflicts: conflicts,
        summary: {
          timeOffConflicts: conflicts.filter(c => c.type === 'time_off_conflict').length,
          overlappingShifts: 0, // Could be expanded in the future
          maxHoursViolations: 0 // Could be expanded in the future
        }
      };
    } catch (error) {
      console.error('Error getting home conflicts:', error);
      throw error;
    }
  }
}

module.exports = SchedulingConflictService;
