/**
 * Hour breakdown for payroll / caps:
 * - `night-sleep` only: first 8h = sleep-in (not paid work); remainder = regular paid hours.
 * - `night-wake`, `special`, legacy `night`, and all other types: full shift span = regular paid hours
 *   (then break deductions apply to that paid portion in the app layer).
 */

const { shiftStartDate, shiftEndDate, LATE_ARRIVAL_MINUTES } = require('./shiftTime');

// Sleeping-night sleep period is the fixed clock window 23:00–06:00 (7h), paid a flat
// allowance (SLEEP_NIGHT_FLAT_PAY_GBP in routes/payroll.js). Hours outside this window
// are paid as regular hourly work. Expressed as minutes-from-midnight on the shift's
// start day; 06:00 is next-day, so the paid band is [1380, 1800].
const NIGHT_SLEEP_START_MIN = 23 * 60; // 1380
const NIGHT_SLEEP_END_MIN = 6 * 60; // 360 (next day)

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
 * Wall-clock minute range for a shift, on a start-day-midnight axis (an overnight end
 * is > 1440). Returns null when times are missing/invalid.
 */
function wallClockRange(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if ([sh, sm, eh, em].some(Number.isNaN)) return null;
  const startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;
  if (endMin < startMin) endMin += 24 * 60;
  return { startMin, endMin };
}

/**
 * Hours of [startMin, endMin] (wall-clock minutes on the shift's start-day axis) that
 * fall inside the nightly 23:00–06:00 sleep window. Checks both the current-night band
 * [1380, 1800] and the previous-night band [-60, 360], so it is correct whether a shift
 * starts in the evening (e.g. 20:00) or after midnight (e.g. 00:00–08:00).
 */
function sleepWindowOverlapHours(startMin, endMin) {
  const bands = [
    [NIGHT_SLEEP_START_MIN, NIGHT_SLEEP_END_MIN + 24 * 60], // [1380, 1800] this night
    [NIGHT_SLEEP_START_MIN - 24 * 60, NIGHT_SLEEP_END_MIN], // [-60, 360] previous night
  ];
  let overlap = 0;
  for (const [bStart, bEnd] of bands) {
    overlap += Math.max(0, Math.min(endMin, bEnd) - Math.max(startMin, bStart));
  }
  return overlap / 60;
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
 * Worked hours clamped to the scheduled window, or null when we don't have a
 * complete, valid clock-in/clock-out pair.
 *
 * Policy (kept in sync with the frontend `src/lib/shiftHours.ts`):
 * - Early clock-in never counts — worked time starts no earlier than scheduled start.
 * - Late clock-out never counts — worked time ends no later than scheduled end
 *   (extra past-the-end time is only paid via a separately-approved overtime request).
 * - Late arrival below LATE_ARRIVAL_MINUTES is forgiven; at or beyond that threshold
 *   the full late time is deducted (worked time starts at the actual clock-in).
 *
 * @param {object} shift - full shift with date/start_time/end_time
 * @param {object} assignment - { clock_in_time, clock_out_time }
 * @returns {number|null}
 */
function effectiveWorkedWindow(shift, assignment) {
  if (!assignment || !assignment.clock_in_time || !assignment.clock_out_time) return null;
  const inMs = new Date(assignment.clock_in_time).getTime();
  const outMs = new Date(assignment.clock_out_time).getTime();
  if (Number.isNaN(inMs) || Number.isNaN(outMs) || outMs <= inMs) return null;

  const schedStart = shiftStartDate(shift).getTime();
  const schedEnd = shiftEndDate(shift).getTime();

  // Early clock-in ignored; late arrival forgiven under the grace threshold,
  // otherwise the full late time is charged to the staff member.
  let effectiveStart = schedStart;
  const lateMinutes = (inMs - schedStart) / 60000;
  if (lateMinutes >= LATE_ARRIVAL_MINUTES) effectiveStart = inMs;

  // Late departure clamped to scheduled end (overtime handled by the caller).
  const effectiveEnd = Math.min(outMs, schedEnd);

  return { startMs: effectiveStart, endMs: effectiveEnd };
}

function clampedWorkedDurationHours(shift, assignment) {
  const w = effectiveWorkedWindow(shift, assignment);
  if (!w) return null;
  return Math.max(0, (w.endMs - w.startMs) / 3600000);
}

/**
 * Hour breakdown ({ duration_hours, sleep_in_hours, paid_work_hours }) computed from the
 * ACTUAL clamped worked window (see effectiveWorkedWindow), or null without a valid
 * clock-in/out pair. For `night-sleep`, the effective window's instants are mapped onto
 * the wall-clock minute axis so the 23:00–06:00 sleep overlap is measured on the hours
 * the staff member actually worked (late arrival / early leave shrink the awake portion).
 * The flat sleep allowance itself is handled by the payroll caller.
 */
function workedHourBreakdown(shift, assignment) {
  const w = effectiveWorkedWindow(shift, assignment);
  if (!w) return null;
  const duration = Math.max(0, (w.endMs - w.startMs) / 3600000);

  if (shift.shift_type !== 'night-sleep') {
    return { duration_hours: duration, sleep_in_hours: 0, paid_work_hours: duration };
  }

  const range = wallClockRange(shift.start_time, shift.end_time);
  const schedStartMs = shiftStartDate(shift).getTime();
  const baseStartMin = range ? range.startMin : 0;
  const startMin = baseStartMin + (w.startMs - schedStartMs) / 60000;
  const endMin = baseStartMin + (w.endMs - schedStartMs) / 60000;
  const sleep_in_hours = sleepWindowOverlapHours(startMin, endMin);

  return {
    duration_hours: duration,
    sleep_in_hours,
    paid_work_hours: Math.max(0, duration - sleep_in_hours),
  };
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
    // Sleep-in is the overlap of the scheduled window with the fixed 23:00–06:00 band
    // (not the first N hours). Computed from wall-clock times so it works for synthetic
    // shift objects without a date; a numeric duration override is not applied here (the
    // clamped-actual path uses workedHourBreakdown instead).
    const range = wallClockRange(shift.start_time, shift.end_time);
    if (!range) {
      const sleep_in_hours = Math.min(7, duration);
      return {
        duration_hours: duration,
        sleep_in_hours,
        paid_work_hours: Math.max(0, duration - sleep_in_hours),
      };
    }
    const scheduledDuration = (range.endMin - range.startMin) / 60;
    const sleep_in_hours = sleepWindowOverlapHours(range.startMin, range.endMin);
    return {
      duration_hours: scheduledDuration,
      sleep_in_hours,
      paid_work_hours: Math.max(0, scheduledDuration - sleep_in_hours),
    };
  }

  return {
    duration_hours: duration,
    sleep_in_hours: 0,
    paid_work_hours: duration,
  };
}

module.exports = {
  NIGHT_SLEEP_START_MIN,
  NIGHT_SLEEP_END_MIN,
  durationFromTimes,
  sleepWindowOverlapHours,
  getShiftHourBreakdown,
  actualDurationHours,
  clampedWorkedDurationHours,
  workedHourBreakdown,
};
