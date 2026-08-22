/**
 * Hour breakdown for payroll / caps:
 * - `night-sleep` only: first 8h = sleep-in (not paid work); remainder = regular paid hours.
 * - `night-wake`, `special`, legacy `night`, and all other types: full shift span = regular paid hours
 *   (then break deductions apply to that paid portion in the app layer).
 */

const NIGHT_SLEEP_IN_HOURS = 8;

function durationFromTimes(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let startTotal = sh * 60 + sm;
  let endTotal = eh * 60 + em;
  if (endTotal < startTotal) endTotal += 24 * 60;
  return (endTotal - startTotal) / 60;
}

/**
 * Actual worked hours from a staff assignment's clock times, or null when we don't
 * have a complete, valid clock-in/clock-out pair.
 * @param {object} assignment - { clock_in_time, clock_out_time }
 * @returns {number|null}
 */
function actualDurationHours(assignment) {
  if (!assignment || !assignment.clock_in_time || !assignment.clock_out_time) return null;
  const inMs = new Date(assignment.clock_in_time).getTime();
  const outMs = new Date(assignment.clock_out_time).getTime();
  if (Number.isNaN(inMs) || Number.isNaN(outMs) || outMs <= inMs) return null;
  return (outMs - inMs) / 3600000;
}

/**
 * @param {object} shift - { shift_type, start_time, end_time, duration_hours? }
 * @param {number} [overrideDurationHours] - when provided, replaces the rostered duration
 *   (e.g. actual clocked hours) before sleep-in/break rules are applied.
 * @returns {{ duration_hours: number, sleep_in_hours: number, paid_work_hours: number }}
 */
function getShiftHourBreakdown(shift, overrideDurationHours) {
  const shiftType = shift.shift_type;
  const hasOverride =
    typeof overrideDurationHours === 'number' && !Number.isNaN(overrideDurationHours);
  const duration = hasOverride
    ? overrideDurationHours
    : (typeof shift.duration_hours === 'number' && !Number.isNaN(shift.duration_hours)
        ? shift.duration_hours
        : durationFromTimes(shift.start_time, shift.end_time));

  // Only sleeping-night uses sleep-in; all other types (including `special`) are paid like regular shifts.
  if (shiftType === 'night-sleep') {
    const sleep_in_hours = Math.min(NIGHT_SLEEP_IN_HOURS, duration);
    const paid_work_hours = Math.max(0, duration - NIGHT_SLEEP_IN_HOURS);
    return { duration_hours: duration, sleep_in_hours, paid_work_hours };
  }

  return {
    duration_hours: duration,
    sleep_in_hours: 0,
    paid_work_hours: duration,
  };
}

module.exports = {
  NIGHT_SLEEP_IN_HOURS,
  durationFromTimes,
  getShiftHourBreakdown,
  actualDurationHours,
};
