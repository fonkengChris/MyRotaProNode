const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const User = require('../models/User');
const TimeOffRequest = require('../models/TimeOffRequest');
const { requireRole } = require('../middleware/auth');
const { getShiftHourBreakdown } = require('../utils/shiftHours');
const { createPayrollPdf, safeFilePart } = require('../utils/payrollPdf');

const DEFAULT_HOURLY_RATE_GBP = 12.71;
const SLEEP_NIGHT_FLAT_PAY_GBP = 50;
const LEAVE_PAID_HOURS_PER_DAY = 7.5;

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

function normalizeNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
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
  };
}

async function getScopedUserIds(homeFilter) {
  if (!homeFilter) return null;
  const homeIds = Array.isArray(homeFilter) ? homeFilter : [homeFilter];
  const users = await User.find({ 'homes.home_id': { $in: homeIds } }).select('_id');
  return new Set(users.map((u) => String(u._id)));
}

async function buildPayrollRecords({
  startDate,
  endDate,
  requestedHomeId,
  currentUser,
  hourlyRate,
  sleepNightFlatPay,
}) {
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

  const scopedUserIds = await getScopedUserIds(homeFilter);

  const shiftFilter = {
    date: { $gte: startDate, $lte: endDate },
    is_active: true,
  };
  if (homeFilter) {
    shiftFilter.home_id = Array.isArray(homeFilter) ? { $in: homeFilter } : homeFilter;
  }

  const shifts = await Shift.find(shiftFilter).populate('assigned_staff.user_id', 'name role');

  const byUser = new Map();
  for (const shift of shifts) {
    const br = getShiftHourBreakdown(shift);
    const breakDeduction = computeBreakDeduction(br.paid_work_hours);
    const paidAfterBreak = Math.max(0, br.paid_work_hours - breakDeduction);
    const assignments = Array.isArray(shift.assigned_staff) ? shift.assigned_staff : [];
    const nightShift = isNightShift(shift.shift_type);

    for (const assignment of assignments) {
      const staff = assignment.user_id;
      if (!staff || !staff._id) continue;
      const uid = String(staff._id);
      if (scopedUserIds && !scopedUserIds.has(uid)) continue;

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
    if (scopedUserIds && !scopedUserIds.has(uid)) continue;

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
      return acc;
    },
    {
      total_day_hours: 0,
      total_night_hours: 0,
      total_paid_hours: 0,
      total_sleep_in_pay: 0,
      total_leave_pay: 0,
      total_gross_pay: 0,
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
    },
  };
}

// JSON payroll report
router.get('/', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const dateRange = requireDateRange(req, res);
    if (!dateRange) return;

    const { startDate, endDate } = dateRange;
    const homeId = normalizeOptionalHomeId(req.query.home_id);
    const hourlyRate = normalizeNonNegativeNumber(req.query.hourly_rate, DEFAULT_HOURLY_RATE_GBP);
    const sleepNightFlatPay = normalizeNonNegativeNumber(
      req.query.sleep_night_pay,
      SLEEP_NIGHT_FLAT_PAY_GBP
    );

    const data = await buildPayrollRecords({
      startDate,
      endDate,
      requestedHomeId: homeId,
      currentUser: req.user,
      hourlyRate,
      sleepNightFlatPay,
    });

    res.json({
      start_date: startDate,
      end_date: endDate,
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
router.get('/pdf', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const dateRange = requireDateRange(req, res);
    if (!dateRange) return;

    const { startDate, endDate } = dateRange;
    const homeId = normalizeOptionalHomeId(req.query.home_id);
    const hourlyRate = normalizeNonNegativeNumber(req.query.hourly_rate, DEFAULT_HOURLY_RATE_GBP);
    const sleepNightFlatPay = normalizeNonNegativeNumber(
      req.query.sleep_night_pay,
      SLEEP_NIGHT_FLAT_PAY_GBP
    );

    const data = await buildPayrollRecords({
      startDate,
      endDate,
      requestedHomeId: homeId,
      currentUser: req.user,
      hourlyRate,
      sleepNightFlatPay,
    });

    let homeNamePart = 'all_homes';
    if (homeId && mongoose.Types.ObjectId.isValid(homeId)) {
      const home = await Home.findById(homeId).select('name');
      if (home && home.name) {
        homeNamePart = safeFilePart(home.name);
      }
    }

    const filename = `payroll_${homeNamePart}_${startDate}_to_${endDate}.pdf`;
    const doc = createPayrollPdf({
      records: data.records,
      startDate,
      endDate,
      generatedBy: req.user?.name,
      hourlyRate,
      sleepNightFlatPay,
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
