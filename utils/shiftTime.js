/**
 * Timezone-aware conversion of a shift's stored `date` (YYYY-MM-DD) + `start_time`/
 * `end_time` (HH:MM, local wall-clock) into real Date instants.
 *
 * Care homes run on UK local time while the server (e.g. Heroku) is UTC, so we must
 * interpret the stored strings in APP_TIMEZONE rather than the server's local zone —
 * otherwise "minutes late" and clock-in windows would be off by the UTC offset.
 */
const moment = require('moment-timezone');

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Europe/London';

// How early (minutes before scheduled start) staff may clock in.
const EARLY_CLOCK_IN_MINUTES = 15;
// A clock-out this many minutes past scheduled end makes the shift overtime-eligible.
const OVERTIME_ELIGIBLE_MINUTES = 30;

function shiftStartDate(shift) {
  return moment.tz(`${shift.date} ${shift.start_time}`, 'YYYY-MM-DD HH:mm', APP_TIMEZONE).toDate();
}

function shiftEndDate(shift) {
  const start = moment.tz(`${shift.date} ${shift.start_time}`, 'YYYY-MM-DD HH:mm', APP_TIMEZONE);
  const end = moment.tz(`${shift.date} ${shift.end_time}`, 'YYYY-MM-DD HH:mm', APP_TIMEZONE);
  // Overnight shift: end wall-clock is earlier than start, so it falls on the next day.
  if (end.isSameOrBefore(start)) {
    end.add(1, 'day');
  }
  return end.toDate();
}

module.exports = {
  APP_TIMEZONE,
  EARLY_CLOCK_IN_MINUTES,
  OVERTIME_ELIGIBLE_MINUTES,
  shiftStartDate,
  shiftEndDate,
};
