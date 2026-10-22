/**
 * Hour breakdown for payroll / caps:
 * - `night-sleep` only: the sleep period is the LAST `getSleepInHours()` hours (default 9,
 *   admin-editable in SolverSettings.sleep_in) of the rostered shift and is NOT paid work; any
 *   earlier hours are regular paid hours. A shift no longer than that is all sleep. Sleep is paid
 *   a flat allowance (SLEEP_NIGHT_FLAT_PAY_GBP in routes/payroll.js).
 * - `night-wake`, `one_to_one`, legacy `night`, and all other types: full shift span = regular paid hours
 *   (then break deductions apply to that paid portion in the app layer).
 */

const {
  shiftStartDate,
  shiftEndDate,
  LATE_ARRIVAL_MINUTES,
  CLOCK_OUT_GRACE_MINUTES,
} = require('./shiftTime');

// Length of the sleep period of a `night-sleep` shift. Org-wide and admin-editable: the
// SolverSettings model pushes its `sleep_in.sleep_hours` here whenever the settings document
// is loaded or saved (and server.js loads it at startup), so these sync helpers — used by
// Shift virtuals, payroll, the solver and caps — don't need it passed in.
const DEFAULT_SLEEP_IN_HOURS = 9;
let sleepInHours = DEFAULT_SLEEP_IN_HOURS;

function setSleepInHours(hours) {
  const n = Number(hours);
  sleepInHours = Number.isFinite(n) && n > 0 ? n : DEFAULT_SLEEP_IN_HOURS;
}

function getSleepInHours() {
  return sleepInHours;
}

// Work hours a full sleep period counts as towards weekly hours limits (not pay). Synced from
// SolverSettings.sleep_in.cap_hours the same way as the sleep length above.
const DEFAULT_SLEEP_CAP_HOURS = 5;
let sleepCapHours = DEFAULT_SLEEP_CAP_HOURS;

function setSleepCapHours(hours) {
  const n = Number(hours);
  sleepCapHours = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLEEP_CAP_HOURS;
}

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
 * Minute (on the shift's start-day axis) at which the sleep period of a rostered
 * [scheduledStartMin, scheduledEndMin] night-sleep shift begins: the last `getSleepInHours()`
 * hours of the shift, or the whole shift if it is shorter. E.g. 20:00–08:00 → 23:00.
 */
function sleepStartMin(scheduledStartMin, scheduledEndMin) {
  return Math.max(scheduledStartMin, scheduledEndMin - sleepInHours * 60);
}

/**
 * Sleep hours of a worked/scheduled window [startMin, endMin] (wall-clock minutes on the
 * shift's start-day axis): its overlap with the sleep period, which is fixed on the ROSTERED
 * times (see sleepStartMin). So late arrival cuts the regular portion and leaving early cuts
 * the sleep portion, each by the time actually missed.
 */
function nightSleepHours(startMin, endMin, scheduledStartMin, scheduledEndMin) {
  const from = Math.max(startMin, sleepStartMin(scheduledStartMin, scheduledEndMin));
  const to = Math.min(endMin, scheduledEndMin);
  return Math.max(0, to - from) / 60;
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
 * the wall-clock minute axis and intersected with the rostered sleep period (the last
 * getSleepInHours() hours of the shift). The flat sleep allowance itself is handled by the
 * payroll caller.
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
  const baseEndMin = range
    ? range.endMin
    : baseStartMin + (shiftEndDate(shift).getTime() - schedStartMs) / 60000;
  const startMin = baseStartMin + (w.startMs - schedStartMs) / 60000;
  const endMin = baseStartMin + (w.endMs - schedStartMs) / 60000;
  const sleep_in_hours = nightSleepHours(startMin, endMin, baseStartMin, baseEndMin);

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

// Fallback break-deduction bands, used when a home has no configured policy (e.g.
// documents created before break_policy existed). Mirrors the historical hard-coded rule.
const DEFAULT_BREAK_TIERS = [
  { min_hours: 8, deduction_hours: 0.5 },
  { min_hours: 12, deduction_hours: 1 },
];

/**
 * Hours of unpaid break to deduct from a shift's paid work hours, per the home's
 * configurable break policy. The highest tier whose `min_hours` threshold is met by
 * `paidWorkHours` wins. A policy with `enabled === false` deducts nothing.
 */
function computeBreakDeduction(paidWorkHours, breakPolicy) {
  if (breakPolicy && breakPolicy.enabled === false) return 0;
  const tiers =
    breakPolicy && Array.isArray(breakPolicy.tiers) && breakPolicy.tiers.length
      ? breakPolicy.tiers
      : DEFAULT_BREAK_TIERS;

  let deduction = 0;
  let bestThreshold = -1;
  for (const tier of tiers) {
    if (paidWorkHours >= tier.min_hours && tier.min_hours > bestThreshold) {
      bestThreshold = tier.min_hours;
      deduction = tier.deduction_hours;
    }
  }
  return deduction;
}

/**
 * Paid work hours for a rostered shift after the home's unpaid break deduction. Weekly
 * hours limits add the sleep period on top: see capHoursAfterBreak.
 */
function paidHoursAfterBreak(shift, breakPolicy) {
  const paid = getShiftHourBreakdown(shift).paid_work_hours;
  return Math.max(0, paid - computeBreakDeduction(paid, breakPolicy));
}

/**
 * Hours a rostered shift counts towards weekly hours limits (solver hard caps and the manual
 * full-time cap): paid work after breaks, plus the sleep period as `sleepCapHours` of work
 * time (pro rata when the shift holds less than a full sleep period). Not used for pay.
 */
function capHoursAfterBreak(shift, breakPolicy) {
  const sleep = getShiftHourBreakdown(shift).sleep_in_hours;
  return paidHoursAfterBreak(shift, breakPolicy) + (sleep / sleepInHours) * sleepCapHours;
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

  // Only sleeping-night uses sleep-in; all other types (including `one_to_one`) are paid like regular shifts.
  if (shiftType === 'night-sleep') {
    // Sleep-in is the last getSleepInHours() hours of the scheduled window; anything before it
    // is regular paid work. Computed from wall-clock times so it works for synthetic shift
    // objects without a date; a numeric duration override is not applied here (the
    // clamped-actual path uses workedHourBreakdown instead).
    const range = wallClockRange(shift.start_time, shift.end_time);
    if (!range) {
      // No usable times: up to getSleepInHours() of the duration is sleep, the rest regular.
      const sleep = Math.min(duration, sleepInHours);
      return {
        duration_hours: duration,
        sleep_in_hours: sleep,
        paid_work_hours: Math.max(0, duration - sleep),
      };
    }
    const scheduledDuration = (range.endMin - range.startMin) / 60;
    const sleep_in_hours = nightSleepHours(range.startMin, range.endMin, range.startMin, range.endMin);
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
  DEFAULT_SLEEP_IN_HOURS,
  setSleepInHours,
  getSleepInHours,
  DEFAULT_SLEEP_CAP_HOURS,
  setSleepCapHours,
  durationFromTimes,
  nightSleepHours,
  restHoursBetween,
  getShiftHourBreakdown,
  DEFAULT_BREAK_TIERS,
  computeBreakDeduction,
  paidHoursAfterBreak,
  capHoursAfterBreak,
  actualDurationHours,
  clampedWorkedDurationHours,
  effectiveWorkedWindow,
  workedHourBreakdown,
};
