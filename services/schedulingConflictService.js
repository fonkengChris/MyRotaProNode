const TimeOffRequest = require('../models/TimeOffRequest');
const Shift = require('../models/Shift');
const User = require('../models/User');
const ConstraintWeights = require('../models/ConstraintWeights');
const { getShiftHourBreakdown, restHoursBetween } = require('../utils/shiftHours');

// Minimum rest gap (hours) required between two of a staff member's shifts. Below this an
// admin may override, and a support worker self-selecting is assigned but flagged for review.
const MIN_REST_HOURS = 8;

// Conflict types an admin may override at assignment time. `overlapping_shift` is deliberately
// excluded — same-time double-booking is always blocked.
const OVERRIDABLE_CONFLICT_TYPES = new Set([
  'time_off',
  'max_hours_exceeded',
  'fulltime_weekly_cap_exceeded',
  'insufficient_rest',
]);

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

  /** The calendar dates one day either side of `dateStr` (YYYY-MM-DD), plus the day itself. */
  static _restWindowDates(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const fmt = (dt) => {
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    };
    const prev = new Date(y, m - 1, d - 1);
    const next = new Date(y, m - 1, d + 1);
    return [fmt(prev), dateStr, fmt(next)];
  }

  /**
   * Check if a shift assignment would create a conflict.
   *
   * Returns `overridable` on the primary conflict and an `overridableConflicts` list of every
   * rule an admin could waive. `overlapping_shift` (same-time double-booking) is never
   * overridable and is always reported first, even when `options.override` is set.
   *
   * @param {string} userId - The user ID to check
   * @param {string} shiftDate - Shift date in YYYY-MM-DD format
   * @param {string} shiftStartTime - Shift start time in HH:MM format
   * @param {string} shiftEndTime - Shift end time in HH:MM format
   * @param {object} [options]
   * @param {string} [options.requesterRole] - Role of user making the assignment (required to exceed full-time weekly cap)
   * @param {string} [options.shiftType] - shift_type of the shift being assigned (for paid-hours / sleep-in rules)
   * @param {boolean} [options.override] - When true, suppress overridable conflicts (only overlap can still block)
   * @returns {Promise<Object>} Conflict information
   */
  static async checkShiftAssignmentConflict(userId, shiftDate, shiftStartTime, shiftEndTime, options = {}) {
    const requesterRole = options.requesterRole;
    const shiftType = options.shiftType;
    const override = !!options.override;
    try {
      // Same-time double-booking is a hard block for everyone and takes precedence over
      // everything else, so it is evaluated first and returned regardless of `override`.
      const overlappingShifts = await Shift.find({
        date: shiftDate,
        'assigned_staff.user_id': userId,
        start_time: { $lt: shiftEndTime },
        end_time: { $gt: shiftStartTime }
      });

      if (overlappingShifts.length > 0) {
        return {
          hasConflict: true,
          conflictType: 'overlapping_shift',
          conflicts: overlappingShifts,
          message: `User already has overlapping shifts on ${shiftDate}`,
          overridable: false,
          overridableConflicts: []
        };
      }

      // Collect every overridable violation so the caller can list them in one dialog.
      const overridableConflicts = [];

      // Approved time off on the shift date.
      const timeOffConflicts = await this.checkTimeOffConflicts(userId, shiftDate, shiftDate);
      if (timeOffConflicts.length > 0) {
        overridableConflicts.push({
          conflictType: 'time_off',
          conflicts: timeOffConflicts,
          message: `User has approved time off on ${shiftDate}`
        });
      }

      // More than 24 hours rostered on the same day.
      const dailyShifts = await Shift.find({
        date: shiftDate,
        'assigned_staff.user_id': userId
      });
      const totalDailyHours = dailyShifts.reduce(
        (total, shift) => total + this._shiftDurationHours(shift.start_time, shift.end_time),
        0
      );
      const totalHours = totalDailyHours + this._shiftDurationHours(shiftStartTime, shiftEndTime);
      if (totalHours > 24) {
        overridableConflicts.push({
          conflictType: 'max_hours_exceeded',
          conflicts: [],
          message: `Total daily hours (${totalHours.toFixed(1)}) would exceed 24 hours`
        });
      }

      // Fewer than MIN_REST_HOURS between this shift and an adjacent-day shift.
      const candidate = { date: shiftDate, start_time: shiftStartTime, end_time: shiftEndTime };
      const nearbyShifts = await Shift.find({
        date: { $in: this._restWindowDates(shiftDate) },
        'assigned_staff.user_id': userId
      }).select('date start_time end_time');
      let minRest = Infinity;
      for (const s of nearbyShifts) {
        const rest = restHoursBetween(s, candidate);
        if (rest === null) continue;
        // Ignore overlaps (rest <= 0): those are handled by the overlap check above.
        if (rest > 0 && rest < minRest) minRest = rest;
      }
      if (minRest < MIN_REST_HOURS) {
        overridableConflicts.push({
          conflictType: 'insufficient_rest',
          conflicts: [],
          message: `Only ${minRest.toFixed(1)}h rest before/after an adjacent shift (minimum ${MIN_REST_HOURS}h)`,
          details: { rest_hours: Math.round(minRest * 10) / 10, min_rest_hours: MIN_REST_HOURS }
        });
      }

      // Full-time staff weekly cap (default 48h); exceeding requires admin or key_worker.
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
          overridableConflicts.push({
            conflictType: 'fulltime_weekly_cap_exceeded',
            conflicts: [],
            message: `Full-time weekly hours would be ${weeklyHours.toFixed(1)} (limit ${policy.capHours}). Only ${policy.approverRoles.join(' or ')} may assign above this limit`,
            details: {
              projected_weekly_hours: Math.round(weeklyHours * 10) / 10,
              cap_hours: policy.capHours,
              week_start: week.start,
              week_end: week.end
            }
          });
        }
      }

      // With override, overridable violations are waived; only overlap (handled above) blocks.
      if (override || overridableConflicts.length === 0) {
        return {
          hasConflict: false,
          conflictType: null,
          conflicts: [],
          message: 'No conflicts detected',
          overridable: false,
          overridableConflicts: []
        };
      }

      const primary = overridableConflicts[0];
      return {
        hasConflict: true,
        conflictType: primary.conflictType,
        conflicts: primary.conflicts,
        message: primary.message,
        details: primary.details,
        overridable: true,
        overridableConflicts: overridableConflicts.map(({ conflictType, message, details }) => ({
          conflictType,
          message,
          details
        }))
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

SchedulingConflictService.MIN_REST_HOURS = MIN_REST_HOURS;
SchedulingConflictService.OVERRIDABLE_CONFLICT_TYPES = OVERRIDABLE_CONFLICT_TYPES;

module.exports = SchedulingConflictService;
