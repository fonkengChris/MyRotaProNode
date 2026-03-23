const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const { requireRole } = require('../middleware/auth');
const { getShiftHourBreakdown } = require('../utils/shiftHours');
const { createPayrollPdf, safeFilePart } = require('../utils/payrollPdf');

const DEFAULT_HOURLY_RATE_GBP = 12.71;
const SLEEP_NIGHT_FLAT_PAY_GBP = 50;

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
          total_rostered_hours: 0,
          total_sleep_in_hours: 0,
          total_paid_hours: 0,
          total_break_deductions: 0,
          total_gross_pay: 0,
        },
      };
    }
    homeFilter = userHomeIds;
  }

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
    for (const assignment of assignments) {
      const staff = assignment.user_id;
      if (!staff || !staff._id) continue;
      const uid = String(staff._id);
      if (!byUser.has(uid)) {
        byUser.set(uid, {
          id: uid,
          user_id: uid,
          name: staff.name || 'Unknown',
          role: staff.role || 'support_worker',
          rostered_hours: 0,
          sleep_in_hours: 0,
          paid_hours: 0,
          break_deductions: 0,
          sleep_night_shifts: 0,
          sleep_night_pay: 0,
          hourly_rate: hourlyRate,
          gross_pay: 0,
        });
      }
      const row = byUser.get(uid);
      row.rostered_hours += br.duration_hours;
      row.sleep_in_hours += br.sleep_in_hours;
      row.break_deductions += breakDeduction;
      row.paid_hours += paidAfterBreak;
      if (shift.shift_type === 'night-sleep') {
        row.sleep_night_shifts += 1;
        row.sleep_night_pay += sleepNightFlatPay;
      }
    }
  }

  const records = Array.from(byUser.values())
    .map((row) => {
      row.gross_pay = row.paid_hours * row.hourly_rate + row.sleep_night_pay;
      return {
        ...row,
        rostered_hours: Number(row.rostered_hours.toFixed(2)),
        sleep_in_hours: Number(row.sleep_in_hours.toFixed(2)),
        paid_hours: Number(row.paid_hours.toFixed(2)),
        break_deductions: Number(row.break_deductions.toFixed(2)),
        sleep_night_pay: Number(row.sleep_night_pay.toFixed(2)),
        gross_pay: Number(row.gross_pay.toFixed(2)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = records.reduce(
    (acc, row) => {
      acc.total_rostered_hours += row.rostered_hours || 0;
      acc.total_sleep_in_hours += row.sleep_in_hours || 0;
      acc.total_paid_hours += row.paid_hours || 0;
      acc.total_break_deductions += row.break_deductions || 0;
      acc.total_sleep_night_pay += row.sleep_night_pay || 0;
      acc.total_gross_pay += row.gross_pay || 0;
      return acc;
    },
    {
      total_rostered_hours: 0,
      total_sleep_in_hours: 0,
      total_paid_hours: 0,
      total_break_deductions: 0,
      total_sleep_night_pay: 0,
      total_gross_pay: 0,
    }
  );

  return {
    records,
    totals: {
      total_rostered_hours: Number(totals.total_rostered_hours.toFixed(2)),
      total_sleep_in_hours: Number(totals.total_sleep_in_hours.toFixed(2)),
      total_paid_hours: Number(totals.total_paid_hours.toFixed(2)),
      total_break_deductions: Number(totals.total_break_deductions.toFixed(2)),
      total_sleep_night_pay: Number(totals.total_sleep_night_pay.toFixed(2)),
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
