/**
 * In-process attendance scheduler. Runs every minute and, for shifts that have started
 * without a clock-in, sends:
 *   - a reminder to the staff member once they are REMINDER_MINUTES late, and
 *   - an escalation to management once they are ESCALATION_MINUTES late.
 *
 * Idempotency: each notice is guarded by a per-assignment `*_sent_at` stamp, so even
 * though the cron fires every minute each notice is sent exactly once. Once a staff
 * member clocks in, `attendance_status` leaves 'not_started' and the assignment is
 * skipped. Shifts whose end has passed with no clock-in are marked 'missed'.
 *
 * NOTE: this assumes a single worker process. Running multiple dynos/instances would
 * double-send; add a distributed lock before scaling out.
 */
const cron = require('node-cron');
const moment = require('moment-timezone');
const Shift = require('../models/Shift');
const { APP_TIMEZONE, shiftStartDate, shiftEndDate } = require('../utils/shiftTime');
const { notifyLateStaff, notifyManagement } = require('./attendanceNotifications');

const REMINDER_MINUTES = parseInt(process.env.ATTENDANCE_REMINDER_MINUTES, 10) || 5;
const ESCALATION_MINUTES = parseInt(process.env.ATTENDANCE_ESCALATION_MINUTES, 10) || 15;

let task = null;

async function runAttendanceCheck(now = new Date()) {
  const today = moment.tz(now, APP_TIMEZONE).format('YYYY-MM-DD');
  const yesterday = moment.tz(now, APP_TIMEZONE).subtract(1, 'day').format('YYYY-MM-DD');

  // Only shifts that still have someone awaiting clock-in are worth scanning.
  // Match on clock_in_time: null (also matches docs predating the attendance fields).
  const shifts = await Shift.find({
    date: { $in: [yesterday, today] },
    is_active: true,
    'assigned_staff.clock_in_time': null,
  })
    .populate('assigned_staff.user_id', 'name email role')
    .populate('home_id', 'name');

  for (const shift of shifts) {
    let dirty = false;
    const start = shiftStartDate(shift);
    const end = shiftEndDate(shift);
    const minutesLate = (now.getTime() - start.getTime()) / 60000;

    if (minutesLate < REMINDER_MINUTES) continue; // shift not yet late enough

    for (const assignment of shift.assigned_staff) {
      if (assignment.status === 'declined') continue;
      if (assignment.clock_in_time) continue; // already clocked in
      if (assignment.attendance_status === 'missed') continue; // already resolved

      const staffUser = assignment.user_id && assignment.user_id._id ? assignment.user_id : null;

      // Shift already ended and they never clocked in -> mark missed, stop reminding.
      if (now > end) {
        assignment.attendance_status = 'missed';
        dirty = true;
        continue;
      }

      if (minutesLate >= REMINDER_MINUTES && !assignment.clock_in_reminder_sent_at) {
        await notifyLateStaff(shift, staffUser);
        assignment.clock_in_reminder_sent_at = now;
        dirty = true;
      }

      if (minutesLate >= ESCALATION_MINUTES && !assignment.clock_in_escalation_sent_at) {
        await notifyManagement(shift, staffUser);
        assignment.clock_in_escalation_sent_at = now;
        dirty = true;
      }
    }

    if (dirty) {
      try {
        await shift.save();
      } catch (error) {
        console.error('[attendanceScheduler] Failed to save shift', shift._id.toString(), error.message);
      }
    }
  }
}

function startAttendanceScheduler() {
  if (task) return task;
  console.log(`🕒 Attendance scheduler started (reminder ${REMINDER_MINUTES}m / escalation ${ESCALATION_MINUTES}m, tz ${APP_TIMEZONE}).`);
  task = cron.schedule('* * * * *', async () => {
    try {
      await runAttendanceCheck();
    } catch (error) {
      console.error('[attendanceScheduler] runAttendanceCheck failed:', error.message);
    }
  });
  return task;
}

function stopAttendanceScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { startAttendanceScheduler, stopAttendanceScheduler, runAttendanceCheck };
