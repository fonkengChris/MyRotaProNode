/**
 * Hour breakdown for payroll / caps:
 * - `night-sleep` only: the sleep-night portion is midnight (00:00) → shift end and is NOT paid work;
 *   the pre-midnight portion (shift start → 00:00) is regular paid hours. Sleep is paid a flat
 *   allowance (SLEEP_NIGHT_FLAT_PAY_GBP in routes/payroll.js).
 * - `night-wake`, `special`, legacy `night`, and all other types: full shift span = regular paid hours
 *   (then break deductions apply to that paid portion in the app layer).
 */

const {
  shiftStartDate,
  shiftEndDate,
  LATE_ARRIVAL_MINUTES,
  CLOCK_OUT_GRACE_MINUTES,
} = require('./shiftTime');

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
 * Sleep-night hours of a worked/scheduled window [startMin, endMin] (wall-clock minutes on the
 * shift's start-day axis). The sleep period runs from the wall-clock midnight during the shift up
 * to the shift end. The boundary is the next 00:00 at or after the scheduled start: an evening
 * start (e.g. 20:00) → 1440; a 00:00 start → 0, so the whole shift is sleep. Anchoring the boundary
 * to the scheduled start (not the possibly-late effective start) keeps late arrival / early leave
 * correctly reducing the pre-midnight regular portion.
 */
function nightSleepHours(startMin, endMin, scheduledStartMin) {
  const boundaryMin = Math.ceil(scheduledStartMin / 1440) * 1440;
  return Math.max(0, endMin - Math.max(startMin, boundaryMin)) / 60;
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
 * - Late arrival below LATE_ARRIVAL_MINUTES is forgiven; at or beyond that threshold
 *   the full late time is deducted (worked time starts at the actual clock-in).
 * - Clock-out within CLOCK_OUT_GRACE_MINUTES either side of the scheduled end counts as
 *   ending exactly at the scheduled end. Beyond that: a late clock-out clamps to the
 *   scheduled end (extra time is only paid via a separately-approved overtime request);
 *   an early clock-out counts the actual time worked.
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

  // Within CLOCK_OUT_GRACE_MINUTES either side of the scheduled end → ends exactly at end.
  // Otherwise: late clock-out clamps to end (overtime handled by the caller); early clock-out
  // counts the actual time worked.
  const outDiffMin = (outMs - schedEnd) / 60000;
  const effectiveEnd =
    Math.abs(outDiffMin) <= CLOCK_OUT_GRACE_MINUTES ? schedEnd : Math.min(outMs, schedEnd);

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
 * the wall-clock minute axis so the midnight→end sleep portion is measured on the hours
 * the staff member actually worked (late arrival / early leave shrink the pre-midnight
 * regular portion). The flat sleep allowance itself is handled by the payroll caller.
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
  const sleep_in_hours = nightSleepHours(startMin, endMin, baseStartMin);

  return {
    duration_hours: duration,
    sleep_in_hours,
    paid_work_hours: Math.max(0, duration - sleep_in_hours),
  };
}

/**
 * Rest gap in hours between two shifts, each `{ date: 'YYYY-MM-DD', start_time, end_time }`.
 * Builds absolute start/end instants (an overnight end rolls to the next day), orders the two
 * shifts by start, and returns `(laterStart - earlierEnd)` in hours. A negative result means
 * the shifts overlap. Returns null if either shift is missing its date or times.
 *
 * Shared by the scheduling-conflict service (interactive assignment) and mirrors the client
 * copy in `src/components/ShiftSelectionModal.tsx`.
 */
function restHoursBetween(shiftA, shiftB) {
  const toInstants = (s) => {
    if (!s || !s.date || !s.start_time || !s.end_time) return null;
    const [y, m, d] = s.date.split('-').map(Number);
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    if ([y, m, d, sh, sm, eh, em].some(Number.isNaN)) return null;
    const start = new Date(y, m - 1, d, sh, sm, 0, 0);
    const end = new Date(y, m - 1, d, eh, em, 0, 0);
    if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);
    return { start: start.getTime(), end: end.getTime() };
  };
  const a = toInstants(shiftA);
  const b = toInstants(shiftB);
  if (!a || !b) return null;
  const [earlier, later] = a.start <= b.start ? [a, b] : [b, a];
  return (later.start - earlier.end) / 3600000;
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
    // Sleep-in is the midnight→end portion of the scheduled window; the pre-midnight portion is
    // regular paid work. Computed from wall-clock times so it works for synthetic shift objects
    // without a date; a numeric duration override is not applied here (the clamped-actual path
    // uses workedHourBreakdown instead).
    const range = wallClockRange(shift.start_time, shift.end_time);
    if (!range) {
      // No usable times: fall back to treating the whole duration as sleep.
      return {
        duration_hours: duration,
        sleep_in_hours: duration,
        paid_work_hours: 0,
      };
    }
    const scheduledDuration = (range.endMin - range.startMin) / 60;
    const sleep_in_hours = nightSleepHours(range.startMin, range.endMin, range.startMin);
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
  durationFromTimes,
  nightSleepHours,
  restHoursBetween,
  getShiftHourBreakdown,
  actualDurationHours,
  clampedWorkedDurationHours,
  workedHourBreakdown,
};
