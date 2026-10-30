/**
 * 1-to-1 shifts vs background shifts.
 *
 * A `one_to_one` shift is created by an admin for a single service user. Every other
 * shift type is a "background" shift (the regular rota). Staff time is never paid
 * twice: a 1-to-1 that falls inside the staff member's own background shift adds no
 * hours, and a partial overlap only pays the time outside their background shifts.
 *
 * A 1-to-1 assignment is "covered" when its whole window sits inside one background
 * shift the same staff member is assigned to. Coverage is computed live (never stored)
 * so it stays correct when the background roster changes. Covered assignments inherit
 * attendance from the background shift: no clock-in, reminders or "missed" marking.
 */
const moment = require('moment-timezone');
const { shiftStartDate, shiftEndDate, APP_TIMEZONE } = require('./shiftTime');
const { getSleepInHours } = require('./shiftHours');

const ONE_TO_ONE = 'one_to_one';

function isOneToOne(shiftOrType) {
  const type = typeof shiftOrType === 'string' ? shiftOrType : shiftOrType?.shift_type;
  return String(type || '').toLowerCase() === ONE_TO_ONE;
}

/** Real-time window of a shift's scheduled times as { startMs, endMs } (overnight-aware). */
function shiftWindow(shift) {
  if (!shift || !shift.date || !shift.start_time || !shift.end_time) return null;
  const startMs = shiftStartDate(shift).getTime();
  const endMs = shiftEndDate(shift).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

/**
 * The part of a background shift's window that is paid work. For `night-sleep` the last
 * getSleepInHours() hours of the ROSTERED shift are a sleep-in (flat allowance, not paid
 * hours), so a 1-to-1 during that time is NOT already paid and must not be subtracted.
 */
function paidPortion(shift, window) {
  if (!window) return null;
  if (shift.shift_type !== 'night-sleep') return window;
  const rostered = shiftWindow(shift);
  if (!rostered) return null;
  const sleepStartMs = Math.max(rostered.startMs, rostered.endMs - getSleepInHours() * 3600000);
  const end = Math.min(window.endMs, sleepStartMs);
  if (end <= window.startMs) return null;
  return { startMs: window.startMs, endMs: end };
}

/**
 * `window` minus every interval in `intervals`.
 * @returns {{ intervals: Array<{startMs:number,endMs:number}>, hours: number }}
 */
function subtractIntervals(window, intervals = []) {
  if (!window || window.endMs <= window.startMs) return { intervals: [], hours: 0 };
  let remaining = [{ startMs: window.startMs, endMs: window.endMs }];
  for (const cut of intervals) {
    if (!cut || cut.endMs <= cut.startMs) continue;
    const next = [];
    for (const r of remaining) {
      if (cut.endMs <= r.startMs || cut.startMs >= r.endMs) {
        next.push(r);
        continue;
      }
      if (cut.startMs > r.startMs) next.push({ startMs: r.startMs, endMs: cut.startMs });
      if (cut.endMs < r.endMs) next.push({ startMs: cut.endMs, endMs: r.endMs });
    }
    remaining = next;
  }
  const ms = remaining.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
  return { intervals: remaining, hours: ms / 3600000 };
}

function windowsOverlap(a, b) {
  return !!a && !!b && a.startMs < b.endMs && b.startMs < a.endMs;
}

function windowContains(outer, inner) {
  return !!outer && !!inner && outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
}

function shiftDateOffset(date, days) {
  return moment.tz(date, 'YYYY-MM-DD', APP_TIMEZONE).add(days, 'day').format('YYYY-MM-DD');
}

/**
 * Active shifts the user is assigned to on date-1 .. date+1 whose real window overlaps
 * `window` (so cross-midnight shifts are found). Returns all types; callers filter.
 */
async function findOverlappingAssignedShifts(userId, date, window, { excludeShiftId, excludeShiftIds = [] } = {}) {
  const Shift = require('../models/Shift');
  const filter = {
    date: { $gte: shiftDateOffset(date, -1), $lte: shiftDateOffset(date, 1) },
    'assigned_staff.user_id': userId,
    is_active: { $ne: false },
  };
  const excluded = [excludeShiftId, ...excludeShiftIds].filter(Boolean);
  if (excluded.length) filter._id = { $nin: excluded };
  const shifts = await Shift.find(filter);
  return shifts.filter((s) => windowsOverlap(shiftWindow(s), window));
}

/** Background shifts of `userId` that overlap the given 1-to-1 shift. */
async function findBackgroundShiftsForUser(userId, oneToOneShift) {
  const window = shiftWindow(oneToOneShift);
  if (!window) return [];
  const shifts = await findOverlappingAssignedShifts(userId, oneToOneShift.date, window, {
    excludeShiftId: oneToOneShift._id,
  });
  return shifts.filter((s) => !isOneToOne(s));
}

/** Pure check against a pre-loaded list of the user's background shifts. */
function isCoveredBy(oneToOneShift, backgroundShifts) {
  const window = shiftWindow(oneToOneShift);
  if (!window) return false;
  return backgroundShifts.some(
    (s) => !isOneToOne(s) && windowContains(paidPortion(s, shiftWindow(s)), window)
  );
}

/** True when the 1-to-1 window lies fully inside one of the user's background shifts. */
async function isCoveredByBackground(oneToOneShift, userId) {
  if (!isOneToOne(oneToOneShift)) return false;
  const bg = await findBackgroundShiftsForUser(userId, oneToOneShift);
  return isCoveredBy(oneToOneShift, bg);
}

/**
 * Rostered extra hours a 1-to-1 adds for a user, given that user's other assigned
 * shifts: the 1-to-1 window minus their background paid windows.
 */
function extraRosteredHours(oneToOneShift, userShifts) {
  const window = shiftWindow(oneToOneShift);
  const cuts = userShifts
    .filter((s) => !isOneToOne(s) && String(s._id) !== String(oneToOneShift._id))
    .map((s) => paidPortion(s, shiftWindow(s)))
    .filter(Boolean);
  return subtractIntervals(window, cuts).hours;
}

module.exports = {
  ONE_TO_ONE,
  isOneToOne,
  shiftWindow,
  paidPortion,
  subtractIntervals,
  windowsOverlap,
  windowContains,
  shiftDateOffset,
  findOverlappingAssignedShifts,
  findBackgroundShiftsForUser,
  isCoveredBy,
  isCoveredByBackground,
  extraRosteredHours,
};
