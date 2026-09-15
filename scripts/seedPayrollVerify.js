/**
 * Seed a self-contained sample week for verifying payroll wage calculation.
 *
 * SAFETY: refuses to run unless MONGODB_URI points at a local host, so this can never
 * touch the production Atlas cluster. Run with an explicit local URI, e.g.:
 *   MONGODB_URI=mongodb://localhost:27017/myrotapro_verify node scripts/seedPayrollVerify.js
 *
 * Creates one home/service, an admin login, and one staff member per payroll scenario
 * (early/late clock-in, early/late/grace clock-out, overtime, sleeping-night, missing
 * clock-out, never-clocked-in, and holiday) so each payroll row maps 1:1 to a case.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const moment = require('moment-timezone');

const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');
const Shift = require('../models/Shift');
const TimeOffRequest = require('../models/TimeOffRequest');
const OvertimeRequest = require('../models/OvertimeRequest');

const TZ = process.env.APP_TIMEZONE || 'Europe/London';
const uri = process.env.MONGODB_URI || '';

if (!/(localhost|127\.0\.0\.1)/.test(uri) || /mongodb\+srv/.test(uri)) {
  console.error(
    `\nREFUSING TO SEED: MONGODB_URI must be a local host for verification.\nGot: ${uri || '(unset)'}\n` +
      `Run with: MONGODB_URI=mongodb://localhost:27017/myrotapro_verify node scripts/seedPayrollVerify.js\n`
  );
  process.exit(1);
}

// The verification week and the working day used for the day-shift scenarios.
const WEEK_START = '2026-09-14'; // Monday
const WEEK_END = '2026-09-20'; // Sunday
const DAY = '2026-09-15'; // Tuesday — all day shifts run 08:00–17:00 (9h)
const NIGHT_DATE = '2026-09-15'; // sleeping night 20:00 → 08:00 next day
const PASSWORD = 'Verify123!';

/** JS Date for a London wall-clock time, matching how the app interprets shift times. */
const at = (date, time) => moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', TZ).toDate();

// Each scenario => one staff user + one shift (except holiday/no-clockin which need no clock pair).
const SCENARIOS = [
  { key: 's01-ontime', name: '01 On-time', role: 'support_worker', in: '08:00', out: '17:00' },
  { key: 's02-grace-inout', name: '02 Early-in + early-out grace', role: 'support_worker', in: '07:50', out: '16:52' },
  { key: 's03-late-forgiven', name: '03 Late 10m (forgiven)', role: 'senior_staff', in: '08:10', out: '17:00' },
  { key: 's04-late-penalty', name: '04 Late 20m (penalty)', role: 'senior_staff', in: '08:20', out: '17:00' },
  { key: 's05-early-out', name: '05 Early-out 30m (beyond grace)', role: 'support_worker', in: '08:00', out: '16:30' },
  { key: 's06-lateout-grace', name: '06 Late-out 8m (grace)', role: 'support_worker', in: '08:00', out: '17:08' },
  { key: 's07-lateout-clamped', name: '07 Late-out 20m (clamped, no OT)', role: 'support_worker', in: '08:00', out: '17:20' },
  { key: 's08-overtime', name: '08 Overtime 45m (approved)', role: 'key_worker', in: '08:00', out: '17:45', overtimeMin: 45 },
  { key: 's09-sleep', name: '09 Sleeping night 20:00-08:00', role: 'senior_staff', night: true, in: '20:00', out: '08:00' },
  { key: 's10-missing-out', name: '10 Missing clock-out (review)', role: 'support_worker', in: '08:00', out: null },
  { key: 's11-no-clockin', name: '11 Never clocked in', role: 'support_worker', in: null, out: null },
  { key: 's12-holiday', name: '12 Holiday (2 days)', role: 'support_worker', holiday: ['2026-09-17', '2026-09-18'] },
];

async function run() {
  await mongoose.connect(uri);
  console.log(`Connected to ${uri}`);

  // Fresh slate for this dedicated verification database only.
  await Promise.all([
    User.deleteMany({}),
    Home.deleteMany({}),
    Service.deleteMany({}),
    Shift.deleteMany({}),
    TimeOffRequest.deleteMany({}),
    OvertimeRequest.deleteMany({}),
  ]);

  const home = await Home.create({
    name: 'Verify House',
    location: { address: '1 Test Street', city: 'London', postcode: 'SW1A 1AA' },
    capacity: 20,
  });

  const service = await Service.create({
    name: 'Personal Care',
    description: 'Personal care service for verification',
    home_id: home._id,
    category: 'personal_care',
    required_skills: ['personal_care'],
    min_staff_count: 1,
    max_staff_count: 5,
    duration_hours: 8,
  });

  let phoneSeq = 1;
  const mkUser = (name, email, role) =>
    User.create({
      name,
      email,
      phone: `+44770090${String(phoneSeq++).padStart(4, '0')}`,
      password: PASSWORD,
      role,
      type: 'fulltime',
      homes: [{ home_id: home._id, is_default: true }],
      default_home_id: home._id,
      skills: ['personal_care'],
    });

  const admin = await mkUser('Verify Admin', 'admin@verify.com', 'admin');

  const baseShift = (userId, extra) => ({
    home_id: home._id,
    service_id: service._id,
    required_staff_count: 1,
    is_active: true,
    assigned_staff: [
      {
        user_id: userId,
        status: 'assigned',
        assigned_at: new Date(),
        ...extra,
      },
    ],
  });

  for (const sc of SCENARIOS) {
    const user = await mkUser(sc.name, `${sc.key}@verify.com`, sc.role);

    if (sc.holiday) {
      await TimeOffRequest.create({
        user_id: user._id,
        start_date: sc.holiday[0],
        end_date: sc.holiday[1],
        reason: 'Verification annual leave',
        request_type: 'annual_leave',
        status: 'approved',
        home_id: home._id,
      });
      continue;
    }

    const isNight = !!sc.night;
    const date = isNight ? NIGHT_DATE : DAY;
    const start = isNight ? '20:00' : '08:00';
    const end = isNight ? '08:00' : '17:00';

    let clock = {};
    if (sc.in && sc.out) {
      const outDate = isNight ? '2026-09-16' : DAY;
      clock = {
        clock_in_time: at(date, sc.in),
        clock_out_time: at(outDate, sc.out),
        attendance_status: 'clocked_out',
      };
    } else if (sc.in && !sc.out) {
      clock = { clock_in_time: at(date, sc.in), attendance_status: 'clocked_in' };
    } else {
      clock = { attendance_status: 'not_started' };
    }

    const shift = await Shift.create({
      ...baseShift(user._id, clock),
      date,
      start_time: start,
      end_time: end,
      shift_type: isNight ? 'night-sleep' : 'day',
    });

    if (sc.overtimeMin) {
      await OvertimeRequest.create({
        shift_id: shift._id,
        user_id: user._id,
        home_id: home._id,
        scheduled_end: at(date, end),
        actual_clock_out: at(date, sc.out),
        requested_minutes: sc.overtimeMin,
        status: 'approved',
        approved_by: admin._id,
        approved_at: new Date(),
      });
    }
  }

  console.log('\nSeed complete.');
  console.log(`  Admin login : admin@verify.com / ${PASSWORD}`);
  console.log(`  Home        : ${home.name} (${home._id})`);
  console.log(`  Payroll week: ${WEEK_START} .. ${WEEK_END}`);
  console.log(`  Scenarios   : ${SCENARIOS.length} staff (one row each)`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
