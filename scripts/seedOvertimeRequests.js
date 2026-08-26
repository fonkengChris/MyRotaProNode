/**
 * Seed / simulate overtime requests from already-seeded attendance.
 *
 * Scans clocked-out assignments whose clock-out is more than
 * OVERTIME_ELIGIBLE_MINUTES past the scheduled end (matching the eligibility
 * rule in routes/overtime.js) and creates one OvertimeRequest per eligible
 * (shift, user) pair, with a realistic spread of statuses:
 *
 *   ~40% approved   (approved_by + approved_at set)
 *   ~35% pending
 *   ~25% denied     (approved_by + approved_at + denial_reason set)
 *
 * Approver = a home_manager of the shift's home, falling back to any admin.
 * Re-runnable: clears existing overtime requests first.
 *
 * Usage: node scripts/seedOvertimeRequests.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const User = require('../models/User');
const OvertimeRequest = require('../models/OvertimeRequest');
const { shiftEndDate, OVERTIME_ELIGIBLE_MINUTES } = require('../utils/shiftTime');

const REASONS = [
  'Late handover — covering staff arrived after shift end.',
  'Resident incident required staff to remain on site.',
  'Waiting for on-call manager to complete medication count.',
  'Short-staffed on the next shift, stayed to cover.',
  'Completing end-of-shift care notes and reports.',
];
const DENIAL_REASONS = [
  'Overtime not pre-authorised by manager.',
  'Handover overran but within acceptable buffer — no OT payable.',
  'Duplicate of hours already logged elsewhere.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function run() {
  await mongoose.connect(
    process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro',
    { serverSelectionTimeoutMS: 8000 }
  );
  console.log('✅ Connected to MongoDB');

  // Build approver lookup: home_id -> a home_manager for that home; plus an admin fallback.
  const managers = await User.find({ role: { $in: ['home_manager', 'senior_staff'] } }).select('_id name role homes');
  const admin = await User.findOne({ role: 'admin' }).select('_id name');
  const managerByHome = new Map();
  for (const m of managers) {
    for (const h of m.homes || []) {
      const hid = h.home_id?.toString();
      if (hid && !managerByHome.has(hid)) managerByHome.set(hid, m._id);
    }
  }
  const approverFor = (homeId) => managerByHome.get(homeId?.toString()) || admin?._id;
  if (!admin && managers.length === 0) throw new Error('No manager/admin user available to act as approver');

  const cleared = await OvertimeRequest.deleteMany({});
  console.log(`🧹 Cleared ${cleared.deletedCount} existing overtime requests`);

  const shifts = await Shift.find({ is_active: true, 'assigned_staff.clock_out_time': { $ne: null } });
  const tally = { approved: 0, pending: 0, denied: 0 };
  const created = [];

  for (const shift of shifts) {
    const scheduledEnd = shiftEndDate(shift);
    for (const a of shift.assigned_staff) {
      if (!a.clock_out_time || a.status === 'declined') continue;
      const eligibleMinutes = Math.round((a.clock_out_time.getTime() - scheduledEnd.getTime()) / 60000);
      if (eligibleMinutes <= OVERTIME_ELIGIBLE_MINUTES) continue;

      // Staff usually request all the extra time, occasionally round down a little.
      const requestedMinutes = Math.max(1, eligibleMinutes - (Math.random() < 0.3 ? Math.floor(Math.random() * 10) : 0));

      const req = new OvertimeRequest({
        shift_id: shift._id,
        user_id: a.user_id,
        home_id: shift.home_id,
        scheduled_end: scheduledEnd,
        actual_clock_out: a.clock_out_time,
        requested_minutes: requestedMinutes,
        reason: pick(REASONS),
        submitted_at: new Date(a.clock_out_time.getTime() + 5 * 60000),
      });

      const r = Math.random();
      if (r < 0.4) {
        req.status = 'approved';
        req.approved_by = approverFor(shift.home_id);
        req.approved_at = new Date(a.clock_out_time.getTime() + 60 * 60000);
        tally.approved++;
      } else if (r < 0.75) {
        // leave pending
        tally.pending++;
      } else {
        req.status = 'denied';
        req.approved_by = approverFor(shift.home_id);
        req.approved_at = new Date(a.clock_out_time.getTime() + 60 * 60000);
        req.denial_reason = pick(DENIAL_REASONS);
        tally.denied++;
      }

      await req.save();
      created.push(req);
    }
  }

  console.log(`\n💾 Created ${created.length} overtime requests.`);
  console.log('📊 By status:');
  console.log(`   approved : ${tally.approved}`);
  console.log(`   pending  : ${tally.pending}`);
  console.log(`   denied   : ${tally.denied}`);

  await mongoose.connection.close();
  console.log('\n🔌 MongoDB connection closed');
}

run().catch(async (err) => {
  console.error('❌ Seed error:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
