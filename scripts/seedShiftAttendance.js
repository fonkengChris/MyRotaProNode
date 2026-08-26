/**
 * Seed / simulate shift attendance (clock-in & clock-out) data.
 *
 * Populates the `assigned_staff[].clock_in_time`, `clock_out_time` and
 * `attendance_status` fields on active shifts so the attendance / payroll
 * views have realistic data to show. Distribution (per assignment):
 *
 *   ~65%  clocked in AND out   -> attendance_status: 'clocked_out'
 *   ~20%  clocked in, NOT out  -> attendance_status: 'clocked_in'  (still on shift / forgot to clock out)
 *   ~15%  never clocked in     -> 'missed' (shift already ended) or 'not_started' (future shift)
 *
 * Clock times are anchored to each shift's own scheduled window (via the same
 * timezone-aware helpers the API uses), with realistic jitter: most people are
 * a little early/late, some run into overtime, a few leave early.
 *
 * Re-runnable: every run resets attendance on all matched shifts and reseeds.
 * Use --reset to only clear attendance (no reseed).
 *
 * Usage:
 *   node scripts/seedShiftAttendance.js
 *   node scripts/seedShiftAttendance.js --reset
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const { shiftStartDate, shiftEndDate, OVERTIME_ELIGIBLE_MINUTES } = require('../utils/shiftTime');

const RESET_ONLY = process.argv.includes('--reset');

// Target distribution weights.
const WEIGHT_CLOCKED_OUT = 0.65; // clocked in and out
const WEIGHT_CLOCKED_IN = 0.20;  // clocked in, not out
// remainder (~0.15) -> not clocked in at all

const MINUTE = 60 * 1000;

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const chance = (p) => Math.random() < p;

/** Pick one of the three attendance outcomes using the weights above. */
function pickOutcome() {
  const r = Math.random();
  if (r < WEIGHT_CLOCKED_OUT) return 'clocked_out';
  if (r < WEIGHT_CLOCKED_OUT + WEIGHT_CLOCKED_IN) return 'clocked_in';
  return 'none';
}

/** Realistic clock-in instant: mostly on time, sometimes a little early/late. */
function clockInAround(start) {
  // -10 min early .. +8 min late is the common case; ~10% are notably late.
  const offset = chance(0.1) ? randInt(9, 25) : randInt(-10, 8);
  return new Date(start.getTime() + offset * MINUTE);
}

/** Realistic clock-out instant relative to scheduled end. */
function clockOutAround(end) {
  const roll = Math.random();
  if (roll < 0.15) {
    // Overtime: comfortably past the OT-eligible threshold.
    return new Date(end.getTime() + randInt(OVERTIME_ELIGIBLE_MINUTES + 5, 120) * MINUTE);
  }
  if (roll < 0.25) {
    // Left a little early.
    return new Date(end.getTime() - randInt(10, 40) * MINUTE);
  }
  // On time-ish.
  return new Date(end.getTime() + randInt(-8, 12) * MINUTE);
}

function clearAttendance(a) {
  a.clock_in_time = null;
  a.clock_out_time = null;
  a.attendance_status = 'not_started';
  a.clock_in_reminder_sent_at = null;
  a.clock_in_escalation_sent_at = null;
}

async function run() {
  await mongoose.connect(
    process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro',
    { serverSelectionTimeoutMS: 8000 }
  );
  console.log('✅ Connected to MongoDB');

  const now = new Date();
  const shifts = await Shift.find({ is_active: true, 'assigned_staff.0': { $exists: true } });
  console.log(`📋 Found ${shifts.length} active shifts with assigned staff. NOW = ${now.toISOString()}`);

  const tally = { clocked_out: 0, clocked_in: 0, missed: 0, not_started: 0, overtime: 0 };
  let touchedShifts = 0;
  let assignmentCount = 0;

  for (const shift of shifts) {
    const start = shiftStartDate(shift);
    const end = shiftEndDate(shift);
    const hasStarted = start <= now;
    const hasEnded = end <= now;
    let changed = false;

    for (const a of shift.assigned_staff) {
      if (a.status === 'declined') continue;
      assignmentCount++;
      clearAttendance(a);
      changed = true;

      if (RESET_ONLY) {
        tally.not_started++;
        continue;
      }

      const outcome = pickOutcome();

      if (outcome === 'clocked_out') {
        const clockIn = clockInAround(start);
        let clockOut = clockOutAround(end);
        if (clockOut <= clockIn) clockOut = new Date(clockIn.getTime() + 60 * MINUTE);
        a.clock_in_time = clockIn;
        a.clock_out_time = clockOut;
        a.attendance_status = 'clocked_out';
        tally.clocked_out++;
        if (clockOut.getTime() - end.getTime() > OVERTIME_ELIGIBLE_MINUTES * MINUTE) tally.overtime++;
      } else if (outcome === 'clocked_in') {
        a.clock_in_time = clockInAround(start);
        a.attendance_status = 'clocked_in';
        tally.clocked_in++;
      } else {
        // Never clocked in: a past shift they missed, or a future shift not yet started.
        a.attendance_status = hasEnded ? 'missed' : 'not_started';
        tally[a.attendance_status]++;
      }
    }

    if (changed) {
      await shift.save();
      touchedShifts++;
    }
  }

  console.log(`\n💾 Updated ${touchedShifts} shifts / ${assignmentCount} assignments.`);
  console.log('📊 Attendance breakdown:');
  console.log(`   clocked in & out : ${tally.clocked_out}  (of which overtime-eligible: ${tally.overtime})`);
  console.log(`   clocked in only  : ${tally.clocked_in}`);
  console.log(`   missed (past)    : ${tally.missed}`);
  console.log(`   not started      : ${tally.not_started}`);

  await mongoose.connection.close();
  console.log('\n🔌 MongoDB connection closed');
}

run().catch(async (err) => {
  console.error('❌ Seed error:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
