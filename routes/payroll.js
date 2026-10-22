const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const User = require('../models/User');
const SolverSettings = require('../models/SolverSettings');
const TimeOffRequest = require('../models/TimeOffRequest');
const OvertimeRequest = require('../models/OvertimeRequest');
const { requireRole, getUserHomeIds } = require('../middleware/auth');
const {
  getShiftHourBreakdown,
  workedHourBreakdown,
  computeBreakDeduction,
  effectiveWorkedWindow,
} = require('../utils/shiftHours');
const {
  isOneToOne,
  shiftWindow,
  paidPortion,
  subtractIntervals,
  isCoveredBy,
  shiftDateOffset,
} = require('../utils/oneToOne');
const { createPayrollPdf, safeFilePart } = require('../utils/payrollPdf');
const { hourlyRateFor } = require('../utils/payRates');

const SLEEP_NIGHT_FLAT_PAY_GBP = 55;
const LEAVE_PAID_HOURS_PER_DAY = 7.5;

// Defense-in-depth upper bound for an admin-supplied sleep-night pay override.
// Values outside [0, max] fall back to the default rather than being applied.
const MAX_SLEEP_NIGHT_FLAT_PAY_GBP = 500;

// Staff fields payroll needs. hourly_rate is `select: false` on User, so it must be
// named explicitly.
const PAYROLL_STAFF_FIELDS = 'name role hourly_rate';

const NIGHT_SHIFT_TYPES = new Set(['night-wake', 'night-sleep', 'night']);

function isValidYmd(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeOptionalHomeId(value) {
  if (value == null) return undefined;
  const str = String(value).trim();
  if (!str || str === 'null' || str === 'undefined') return undefined;
  return str;
}

function requireDateRange(req, res) {
  const { start_date: startDate, end_date: endDate } = req.query;
  if (!isValidYmd(startDate) || !isValidYmd(endDate)) {
    res.status(400).json({
      error: 'Valid start_date and end_date are required in YYYY-MM-DD format',
    });
    return null;
  }
  if (startDate > endDate) {
    res.status(400).json({ error: 'start_date must be before or equal to end_date' });
    return null;
  }
  return { startDate, endDate };
}


function normalizeBoundedNumber(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return fallback;
  return parsed;
}

/**
 * Resolve the per-run pay settings for a report.
 *
 * Wages are paid at each staff member's own `hourly_rate` (set on their profile), so
 * the only per-run override left is the sleep-night flat pay. Only admins may override
 * it, and the value is clamped to a sane upper bound so a typo (or a tampered request)
 * cannot inflate gross pay.
 */
function resolvePayRates(req) {
  if (req.user?.role !== 'admin') {
    return { sleepNightFlatPay: SLEEP_NIGHT_FLAT_PAY_GBP };
  }
  return {
    sleepNightFlatPay: normalizeBoundedNumber(
      req.query.sleep_night_pay,
      SLEEP_NIGHT_FLAT_PAY_GBP,
      MAX_SLEEP_NIGHT_FLAT_PAY_GBP
    ),
  };
}

function isNightShift(shiftType) {
  return NIGHT_SHIFT_TYPES.has(shiftType);
}

/** Inclusive calendar days between two YYYY-MM-DD strings. */
function countInclusiveDays(startYmd, endYmd) {
  if (!isValidYmd(startYmd) || !isValidYmd(endYmd) || startYmd > endYmd) return 0;
  const start = new Date(`${startYmd}T00:00:00Z`);
  const end = new Date(`${endYmd}T00:00:00Z`);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((end - start) / msPerDay) + 1;
}

function countOverlapDays(rangeStart, rangeEnd, periodStart, periodEnd) {
  const start = rangeStart > periodStart ? rangeStart : periodStart;
  const end = rangeEnd < periodEnd ? rangeEnd : periodEnd;
  return countInclusiveDays(start, end);
}

function createEmptyPayrollRow({ uid, name, role, hourlyRate }) {
  return {
    id: uid,
    user_id: uid,
    name: name || 'Unknown',
    role: role || 'support_worker',
    day_hours: 0,
    night_hours: 0,
    paid_hours: 0,
    break_deductions: 0,
    sleep_night_shifts: 0,
    sleep_in_pay: 0,
    leave_days: 0,
    leave_pay: 0,
    hourly_rate: hourlyRate,
    gross_pay: 0,
    // Attendance reconciliation: count of shifts paid on rostered time because clock
    // data was missing/incomplete, so a manager can review them.
    needs_review: 0,
    // Paid hours from 1-to-1 shifts beyond the staff member's background shifts
    // (already included in day_hours; reported separately for visibility).
    one_to_one_hours: 0,
  };
}

/**
 * The window of a background assignment that is already paid, so a 1-to-1 over the
 * same time adds nothing. Draft (and final without a clock-out) use the rostered window;
 * final with a full clock pair uses the clamped worked window. Final without a clock-in
 * pays nothing, so nothing is subtracted. Sleep-in time is never "paid" here.
 */
function backgroundPaidWindow(shift, assignment, isDraft) {
  if (isDraft) return paidPortion(shift, shiftWindow(shift));
  if (!assignment.clock_in_time) return null;
  const worked = effectiveWorkedWindow(shift, assignment);
  return paidPortion(shift, worked || shiftWindow(shift));
}

/** Resolve a user's "home of record" for leave attribution. */
function resolveDefaultHomeId(user) {
  if (user.default_home_id) return String(user.default_home_id);
  const homes = Array.isArray(user.homes) ? user.homes : [];
  const flagged = homes.find((h) => h && h.is_default && h.home_id);
  if (flagged) return String(flagged.home_id);
  const first = homes.find((h) => h && h.home_id);
  return first ? String(first.home_id) : null;
}

/**
 * Users in scope for the given home filter, mapped to their default home id.
 *
 * The map key set is used to scope shift assignments (unchanged behaviour); the
 * default-home value is used to attribute leave to exactly one home so that
 * multi-home staff are not double-counted across single-home reports.
 * Returns null when no home filter applies (admin viewing all homes).
 */
async function getScopedUsers(homeFilter) {
  if (!homeFilter) return null;
  const homeIds = Array.isArray(homeFilter) ? homeFilter : [homeFilter];
  const users = await User.find({ 'homes.home_id': { $in: homeIds } }).select(
    '_id default_home_id homes'
  );
  const map = new Map();
  for (const user of users) {
    map.set(String(user._id), resolveDefaultHomeId(user));
  }
  return map;
}

/**
 * Pass 2 of payroll: pay each 1-to-1 assignment only for the time outside the staff
 * member's background shifts (and outside 1-to-1 time already counted for them).
 * - Covered (fully inside one of their background shifts) → adds nothing, no clock-in
 *   needed (attendance is inherited from the background shift).
 * - Otherwise the normal clock rules apply (final: no clock-in → unpaid; no clock-out →
 *   rostered + needs_review), then the background paid windows are subtracted.
 * Extra hours count as day hours, get their own break deduction, and approved overtime
 * on the 1-to-1 is added on top as usual.
 */
async function addOneToOneHours({
  oneToOneShifts,
  isDraft,
  scopedUsers,
  approvedOvertime,
  breakPolicyByHome,
  ensureRow,
}) {
  if (!oneToOneShifts.length) return;

  const staffIds = new Set();
  let minDate = null;
  let maxDate = null;
  for (const shift of oneToOneShifts) {
    for (const a of shift.assigned_staff || []) {
      if (a.user_id && a.user_id._id) staffIds.add(String(a.user_id._id));
    }
    if (!minDate || shift.date < minDate) minDate = shift.date;
    if (!maxDate || shift.date > maxDate) maxDate = shift.date;
  }
  if (!staffIds.size) return;

  // Background shifts of these staff around the period, at any home (date±1 so
  // overnight shifts that cover an early-morning 1-to-1 are included).
  const backgroundShifts = await Shift.find({
    date: { $gte: shiftDateOffset(minDate, -1), $lte: shiftDateOffset(maxDate, 1) },
    is_active: true,
    shift_type: { $ne: 'one_to_one' },
    'assigned_staff.user_id': { $in: [...staffIds] },
  });

  const bgShiftsByUser = new Map();
  const paidWindowsByUser = new Map();
  for (const shift of backgroundShifts) {
    for (const a of shift.assigned_staff || []) {
      const uid = String(a.user_id);
      if (!staffIds.has(uid)) continue;
      if (!bgShiftsByUser.has(uid)) bgShiftsByUser.set(uid, []);
      bgShiftsByUser.get(uid).push(shift);
      const w = backgroundPaidWindow(shift, a, isDraft);
      if (w) {
        if (!paidWindowsByUser.has(uid)) paidWindowsByUser.set(uid, []);
        paidWindowsByUser.get(uid).push(w);
      }
    }
  }

  const sorted = [...oneToOneShifts].sort((a, b) =>
    `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`)
  );
  for (const shift of sorted) {
    const breakPolicy = breakPolicyByHome.get(String(shift.home_id));
    for (const assignment of shift.assigned_staff || []) {
      const staff = assignment.user_id;
      if (!staff || !staff._id) continue;
      const uid = String(staff._id);
      if (scopedUsers && !scopedUsers.has(uid)) continue;

      if (isCoveredBy(shift, bgShiftsByUser.get(uid) || [])) continue;

      let window = shiftWindow(shift);
      let needsReview = false;
      if (!isDraft) {
        if (!assignment.clock_in_time) continue;
        const worked = effectiveWorkedWindow(shift, assignment);
        if (worked) window = worked;
        else needsReview = true;
      }
      if (!window) continue;

      const counted = paidWindowsByUser.get(uid) || [];
      const extra = subtractIntervals(window, counted);
      // Later overlapping 1-to-1s must not pay this time again.
      paidWindowsByUser.set(uid, [...counted, ...extra.intervals]);

      const overtimeMinutes = approvedOvertime.get(`${shift._id.toString()}:${uid}`) || 0;
      const breakDeduction = computeBreakDeduction(extra.hours, breakPolicy);
      const paid = Math.max(0, extra.hours - breakDeduction) + overtimeMinutes / 60;
      if (paid <= 0 && !needsReview) continue;

      const row = ensureRow(staff);
      row.break_deductions += breakDeduction;
      if (needsReview) row.needs_review += 1;
      row.day_hours += paid;
      row.one_to_one_hours += paid;
    }
  }
}

async function buildPayrollRecords({
  startDate,
  endDate,
  requestedHomeId,
  currentUser,
  sleepNightFlatPay,
  mode = 'final',
}) {
  // Draft = estimate from rostered hours + approved leave (ignores clock data and
  // overtime). Final = payable hours from clock-validated shifts + approved
  // overtime, falling back to rostered time (flagged for review) when a shift was
  // never clocked out.
  const isDraft = mode === 'draft';
  const isAdmin = currentUser.role === 'admin';
  // Re-read org settings so the sleep-in length used below is the stored one (the
  // settings model syncs it into utils/shiftHours on load).
  await SolverSettings.getSettings();
  const userHomeIds = getUserHomeIds(currentUser);

  let homeFilter = null;
  if (requestedHomeId) {
    if (!mongoose.Types.ObjectId.isValid(requestedHomeId)) {
      const err = new Error('Invalid home_id');
      err.status = 400;
      throw err;
    }

    if (!isAdmin && !userHomeIds.includes(String(requestedHomeId))) {
      const err = new Error('Access denied. You can only access payroll for your assigned home(s).');
      err.status = 403;
      throw err;
    }
    homeFilter = String(requestedHomeId);
  } else if (!isAdmin) {
    if (!userHomeIds.length) {
      return {
        records: [],
        totals: {
          total_day_hours: 0,
          total_night_hours: 0,
          total_paid_hours: 0,
          total_sleep_nights: 0,
          total_sleep_in_pay: 0,
          total_leave_pay: 0,
          total_gross_pay: 0,
          total_one_to_one_hours: 0,
        },
      };
    }
    homeFilter = userHomeIds;
  }

  const scopedUsers = await getScopedUsers(homeFilter);
  const homeFilterSet = homeFilter
    ? new Set(Array.isArray(homeFilter) ? homeFilter : [homeFilter])
    : null;

  const shiftFilter = {
    date: { $gte: startDate, $lte: endDate },
    is_active: true,
  };
  if (homeFilter) {
    shiftFilter.home_id = Array.isArray(homeFilter) ? { $in: homeFilter } : homeFilter;
  }

  const shifts = await Shift.find(shiftFilter).populate('assigned_staff.user_id', PAYROLL_STAFF_FIELDS);

  // Break deductions are configured per home, so resolve each home's policy once and
  // key it by home id for use while walking the shifts below.
  const shiftHomeIds = [
    ...new Set(shifts.map((s) => s.home_id && String(s.home_id)).filter(Boolean)),
  ];
  const homesForShifts = shiftHomeIds.length
    ? await Home.find({ _id: { $in: shiftHomeIds } }).select('break_policy')
    : [];
  const breakPolicyByHome = new Map(
    homesForShifts.map((h) => [String(h._id), h.break_policy])
  );

  // Approved overtime minutes, keyed by `${shiftId}:${userId}`, added on top of the
  // rostered-clamped hours (see attendance reconciliation below). Draft is a rostered
  // estimate, so overtime (which hasn't been worked/approved yet) is not fetched.
  const approvedOvertime = isDraft
    ? new Map()
    : await OvertimeRequest.getApprovedMinutesMap(shifts.map((s) => s._id));

  const byUser = new Map();
  const ensureRow = (staff) => {
    const uid = String(staff._id);
    if (!byUser.has(uid)) {
      byUser.set(
        uid,
        createEmptyPayrollRow({
          uid,
          name: staff.name,
          role: staff.role,
          hourlyRate: hourlyRateFor(staff),
        })
      );
    }
    return byUser.get(uid);
  };

  // Pass 1 covers background shifts; 1-to-1 shifts are paid in pass 2 for only the time
  // outside each staff member's background shifts.
  const oneToOneShifts = [];
  for (const shift of shifts) {
    if (isOneToOne(shift)) {
      oneToOneShifts.push(shift);
      continue;
    }
    // Rostered breakdown is the ceiling for pay (clamp-to-rostered policy).
    const rosteredBr = getShiftHourBreakdown(shift);
    const assignments = Array.isArray(shift.assigned_staff) ? shift.assigned_staff : [];
    const nightShift = isNightShift(shift.shift_type);
    const breakPolicy = breakPolicyByHome.get(String(shift.home_id));

    for (const assignment of assignments) {
      const staff = assignment.user_id;
      if (!staff || !staff._id) continue;
      const uid = String(staff._id);
      if (scopedUsers && !scopedUsers.has(uid)) continue;

      // Draft always pays rostered hours (an estimate). Final only counts a shift
      // once the staff member has clocked IN: a shift never clocked into is not paid
      // at all. Once clocked in, pay is based on ACTUAL clocked time, clamped to the
      // scheduled window: early clock-in / late clock-out never inflate pay, and
      // arriving 30+ min late deducts the late time. A missing clock-OUT falls back
      // to rostered hours and flags the row for manager review.
      let br = rosteredBr;
      let needsReview = false;
      if (!isDraft) {
        if (!assignment.clock_in_time) {
          // Not clocked in — excluded from final payroll entirely.
          continue;
        }
        const wb = workedHourBreakdown(shift, assignment);
        if (wb != null) {
          br = wb;
        } else {
          needsReview = true;
        }
      }

      // Approved overtime (extra minutes past scheduled end) is added on top. Empty
      // in draft mode.
      const overtimeMinutes = approvedOvertime.get(`${shift._id.toString()}:${uid}`) || 0;
      const overtimeHours = overtimeMinutes / 60;

      const breakDeduction = computeBreakDeduction(br.paid_work_hours, breakPolicy);
      const paidAfterBreak = Math.max(0, br.paid_work_hours - breakDeduction) + overtimeHours;

      const row = ensureRow(staff);
      row.break_deductions += breakDeduction;
      if (needsReview) row.needs_review += 1;

      if (nightShift) {
        row.night_hours += paidAfterBreak;
      } else {
        row.day_hours += paidAfterBreak;
      }

      if (shift.shift_type === 'night-sleep') {
        row.sleep_night_shifts += 1;
        row.sleep_in_pay += sleepNightFlatPay;
      }
    }
  }

  await addOneToOneHours({ oneToOneShifts, isDraft, scopedUsers, approvedOvertime, breakPolicyByHome, ensureRow });

  const timeOffRequests = await TimeOffRequest.find({
    status: 'approved',
    start_date: { $lte: endDate },
    end_date: { $gte: startDate },
  }).populate('user_id', PAYROLL_STAFF_FIELDS);

  for (const request of timeOffRequests) {
    const staff = request.user_id;
    if (!staff || !staff._id) continue;
    const uid = String(staff._id);

    // Attribute leave to a single home so multi-home staff are not double-counted.
    // When a home filter is active, a user's leave belongs to their default home;
    // it is only included if that default home falls within the requested scope.
    if (scopedUsers) {
      if (!scopedUsers.has(uid)) continue;
      const defaultHomeId = scopedUsers.get(uid);
      if (!defaultHomeId || !homeFilterSet.has(defaultHomeId)) continue;
    }

    const leaveDays = countOverlapDays(request.start_date, request.end_date, startDate, endDate);
    if (leaveDays <= 0) continue;

    if (!byUser.has(uid)) {
      byUser.set(
        uid,
        createEmptyPayrollRow({
          uid,
          name: staff.name,
          role: staff.role,
          hourlyRate: hourlyRateFor(staff),
        })
      );
    }

    const row = byUser.get(uid);
    row.leave_days += leaveDays;
    row.leave_pay += leaveDays * LEAVE_PAID_HOURS_PER_DAY * row.hourly_rate;
  }

  const records = Array.from(byUser.values())
    .map((row) => {
      row.paid_hours = row.day_hours + row.night_hours;
      row.gross_pay =
        row.paid_hours * row.hourly_rate + row.sleep_in_pay + row.leave_pay;

      return {
        ...row,
        day_hours: Number(row.day_hours.toFixed(2)),
        night_hours: Number(row.night_hours.toFixed(2)),
        paid_hours: Number(row.paid_hours.toFixed(2)),
        break_deductions: Number(row.break_deductions.toFixed(2)),
        one_to_one_hours: Number(row.one_to_one_hours.toFixed(2)),
        sleep_in_pay: Number(row.sleep_in_pay.toFixed(2)),
        leave_days: row.leave_days,
        leave_pay: Number(row.leave_pay.toFixed(2)),
        gross_pay: Number(row.gross_pay.toFixed(2)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = records.reduce(
    (acc, row) => {
      acc.total_day_hours += row.day_hours || 0;
      acc.total_night_hours += row.night_hours || 0;
      acc.total_paid_hours += row.paid_hours || 0;
      acc.total_sleep_nights += row.sleep_night_shifts || 0;
      acc.total_sleep_in_pay += row.sleep_in_pay || 0;
      acc.total_leave_pay += row.leave_pay || 0;
      acc.total_gross_pay += row.gross_pay || 0;
      acc.total_needs_review += row.needs_review || 0;
      acc.total_one_to_one_hours += row.one_to_one_hours || 0;
      return acc;
    },
    {
      total_day_hours: 0,
      total_night_hours: 0,
      total_paid_hours: 0,
      total_sleep_nights: 0,
      total_sleep_in_pay: 0,
      total_leave_pay: 0,
      total_gross_pay: 0,
      total_needs_review: 0,
      total_one_to_one_hours: 0,
    }
  );

  return {
    records,
    totals: {
      total_day_hours: Number(totals.total_day_hours.toFixed(2)),
      total_night_hours: Number(totals.total_night_hours.toFixed(2)),
      total_paid_hours: Number(totals.total_paid_hours.toFixed(2)),
      total_sleep_nights: totals.total_sleep_nights,
      total_sleep_in_pay: Number(totals.total_sleep_in_pay.toFixed(2)),
      total_leave_pay: Number(totals.total_leave_pay.toFixed(2)),
      total_gross_pay: Number(totals.total_gross_pay.toFixed(2)),
      total_needs_review: totals.total_needs_review,
      total_one_to_one_hours: Number(totals.total_one_to_one_hours.toFixed(2)),
    },
  };
}

// JSON payroll report
router.get('/', requireRole(['admin']), async (req, res) => {
  try {
    const dateRange = requireDateRange(req, res);
    if (!dateRange) return;

    const { startDate, endDate } = dateRange;
    const homeId = normalizeOptionalHomeId(req.query.home_id);
    const mode = req.query.mode === 'draft' ? 'draft' : 'final';
    const { sleepNightFlatPay } = resolvePayRates(req);

    const data = await buildPayrollRecords({
      startDate,
      endDate,
      requestedHomeId: homeId,
      currentUser: req.user,
      sleepNightFlatPay,
      mode,
    });

    res.json({
      start_date: startDate,
      end_date: endDate,
      mode,
      records: data.records,
      totals: data.totals,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error('Error generating payroll report:', error);
    res.status(status).json({ error: error.message || 'Failed to generate payroll report' });
  }
});

// PDF payroll export
router.get('/pdf', requireRole(['admin']), async (req, res) => {
  try {
    const dateRange = requireDateRange(req, res);
    if (!dateRange) return;

    const { startDate, endDate } = dateRange;
    const homeId = normalizeOptionalHomeId(req.query.home_id);
    const mode = req.query.mode === 'draft' ? 'draft' : 'final';
    const { sleepNightFlatPay } = resolvePayRates(req);

    const data = await buildPayrollRecords({
      startDate,
      endDate,
      requestedHomeId: homeId,
      currentUser: req.user,
      sleepNightFlatPay,
      mode,
    });

    let homeNamePart = 'all_homes';
    if (homeId && mongoose.Types.ObjectId.isValid(homeId)) {
      const home = await Home.findById(homeId).select('name');
      if (home && home.name) {
        homeNamePart = safeFilePart(home.name);
      }
    }

    const filename = `payroll_${mode}_${homeNamePart}_${startDate}_to_${endDate}.pdf`;
    const doc = createPayrollPdf({
      records: data.records,
      startDate,
      endDate,
      generatedBy: req.user?.name,
      sleepNightFlatPay,
      mode,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);
    doc.end();
  } catch (error) {
    const status = error.status || 500;
    console.error('Error generating payroll PDF:', error);
    if (!res.headersSent) {
      res.status(status).json({ error: error.message || 'Failed to generate payroll PDF' });
    }
  }
});

module.exports = router;
