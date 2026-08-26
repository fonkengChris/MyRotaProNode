const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const User = require('../models/User');
const TimeOffRequest = require('../models/TimeOffRequest');
const OvertimeRequest = require('../models/OvertimeRequest');
const { requireRole } = require('../middleware/auth');
const { getShiftHourBreakdown, workedHourBreakdown } = require('../utils/shiftHours');
const { createPayrollPdf, safeFilePart } = require('../utils/payrollPdf');

const DEFAULT_HOURLY_RATE_GBP = 12.71;
const SLEEP_NIGHT_FLAT_PAY_GBP = 55;
const LEAVE_PAID_HOURS_PER_DAY = 7.5;

// Defense-in-depth upper bounds for admin-supplied pay-rate overrides.
// Values outside [0, max] fall back to the default rather than being applied.
const MAX_HOURLY_RATE_GBP = 100;
const MAX_SLEEP_NIGHT_FLAT_PAY_GBP = 500;

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

function getUserHomeIds(user) {
  const homes = Array.isArray(user.homes) ? user.homes : [];
  return homes
    .map((h) => h && h.home_id)
    .filter(Boolean)
    .map((id) => String(id));
}

function computeBreakDeduction(paidWorkHours) {
  if (paidWorkHours >= 12) return 1;
  if (paidWorkHours >= 8) return 0.5;
  return 0;
}

function normalizeBoundedNumber(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return fallback;
  return parsed;
}

/**
 * Resolve the pay rates to use for a report.
 *
 * Pay rates directly determine how much staff are paid, so overriding them is a
 * privileged action. Only admins may override the defaults; for any other role
 * the client-supplied hourly_rate / sleep_night_pay values are ignored and the
 * statutory defaults are used. Admin overrides are additionally clamped to sane
 * upper bounds so a typo (or a tampered request) cannot inflate gross pay.
 */
function resolvePayRates(req) {
  if (req.user?.role !== 'admin') {
    return {
      hourlyRate: DEFAULT_HOURLY_RATE_GBP,
      sleepNightFlatPay: SLEEP_NIGHT_FLAT_PAY_GBP,
    };
  }

  return {
    hourlyRate: normalizeBoundedNumber(
      req.query.hourly_rate,
      DEFAULT_HOURLY_RATE_GBP,
      MAX_HOURLY_RATE_GBP
    ),
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
  };
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

async function buildPayrollRecords({
  startDate,
  endDate,
  requestedHomeId,
  currentUser,
  hourlyRate,
  sleepNightFlatPay,
  mode = 'final',
}) {
  // Draft = estimate from rostered hours + approved leave (ignores clock data and
  // overtime). Final = payable hours from clock-validated shifts + approved
  // overtime, falling back to rostered time (flagged for review) when a shift was
  // never clocked out.
  const isDraft = mode === 'draft';
  const isAdmin = currentUser.role === 'admin';
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
          total_sleep_in_pay: 0,
          total_leave_pay: 0,
          total_gross_pay: 0,
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

  const shifts = await Shift.find(shiftFilter).populate('assigned_staff.user_id', 'name role');

  // Approved overtime minutes, keyed by `${shiftId}:${userId}`, added on top of the
  // rostered-clamped hours (see attendance reconciliation below). Draft is a rostered
  // estimate, so overtime (which hasn't been worked/approved yet) is not fetched.
  const approvedOvertime = isDraft
    ? new Map()
    : await OvertimeRequest.getApprovedMinutesMap(shifts.map((s) => s._id));

  const byUser = new Map();
  for (const shift of shifts) {
    // Rostered breakdown is the ceiling for pay (clamp-to-rostered policy).
    const rosteredBr = getShiftHourBreakdown(shift);
    const assignments = Array.isArray(shift.assigned_staff) ? shift.assigned_staff : [];
    const nightShift = isNightShift(shift.shift_type);

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

      const breakDeduction = computeBreakDeduction(br.paid_work_hours);
      const paidAfterBreak = Math.max(0, br.paid_work_hours - breakDeduction) + overtimeHours;

      if (!byUser.has(uid)) {
        byUser.set(
          uid,
          createEmptyPayrollRow({
            uid,
            name: staff.name,
            role: staff.role,
            hourlyRate,
          })
        );
      }
      const row = byUser.get(uid);
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

  const timeOffRequests = await TimeOffRequest.find({
    status: 'approved',
    start_date: { $lte: endDate },
    end_date: { $gte: startDate },
  }).populate('user_id', 'name role');

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
          hourlyRate,
        })
      );
    }

    const row = byUser.get(uid);
    row.leave_days += leaveDays;
    row.leave_pay += leaveDays * LEAVE_PAID_HOURS_PER_DAY * hourlyRate;
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
      acc.total_sleep_in_pay += row.sleep_in_pay || 0;
      acc.total_leave_pay += row.leave_pay || 0;
      acc.total_gross_pay += row.gross_pay || 0;
      acc.total_needs_review += row.needs_review || 0;
      return acc;
    },
    {
      total_day_hours: 0,
      total_night_hours: 0,
      total_paid_hours: 0,
      total_sleep_in_pay: 0,
      total_leave_pay: 0,
      total_gross_pay: 0,
      total_needs_review: 0,
    }
  );

  return {
    records,
    totals: {
      total_day_hours: Number(totals.total_day_hours.toFixed(2)),
      total_night_hours: Number(totals.total_night_hours.toFixed(2)),
      total_paid_hours: Number(totals.total_paid_hours.toFixed(2)),
      total_sleep_in_pay: Number(totals.total_sleep_in_pay.toFixed(2)),
      total_leave_pay: Number(totals.total_leave_pay.toFixed(2)),
      total_gross_pay: Number(totals.total_gross_pay.toFixed(2)),
      total_needs_review: totals.total_needs_review,
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
    const { hourlyRate, sleepNightFlatPay } = resolvePayRates(req);

    const data = await buildPayrollRecords({
      startDate,
      endDate,
      requestedHomeId: homeId,
      currentUser: req.user,
      hourlyRate,
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
    const { hourlyRate, sleepNightFlatPay } = resolvePayRates(req);

    const data = await buildPayrollRecords({
      startDate,
      endDate,
      requestedHomeId: homeId,
      currentUser: req.user,
      hourlyRate,
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
      hourlyRate,
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
