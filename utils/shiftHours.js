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
 * @param {object} shift - { shift_type, start_time, end_time, duration_hours? }
 * @returns {{ duration_hours: number, sleep_in_hours: number, paid_work_hours: number }}
 */
function getShiftHourBreakdown(shift) {
  const shiftType = shift.shift_type;
  const duration =
    typeof shift.duration_hours === 'number' && !Number.isNaN(shift.duration_hours)
      ? shift.duration_hours
      : durationFromTimes(shift.start_time, shift.end_time);

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
};
