/**
 * One-off migration: give every user their own `hourly_rate`.
 *
 * Pay used to be a per-role rate set on each payroll run; it is now an attribute of
 * each staff member. Users without a stored rate get the current default for their
 * role (support_worker 12.71, senior_staff 14, key_worker 15, admin 14), so payroll
 * totals are unchanged until an admin edits an individual's rate.
 *
 * Usage:  MONGODB_URI=... node scripts/backfillStaffHourlyRates.js
 * Idempotent: users that already have a rate are left alone.
 */
const mongoose = require('mongoose');
const { DEFAULT_ROLE_RATES_GBP, FALLBACK_HOURLY_RATE_GBP } = require('../utils/payRates');

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';

// Legacy role still present in un-migrated data.
const ROLE_ALIASES = { home_manager: 'key_worker' };

async function run() {
  console.log('🔌 Connecting to MongoDB:', MONGODB_URI.replace(/\/\/[^@/]*@/, '//***@'));
  await mongoose.connect(MONGODB_URI);
  const users = mongoose.connection.db.collection('users');
  const missing = { $or: [{ hourly_rate: { $exists: false } }, { hourly_rate: null }] };

  const roles = { ...DEFAULT_ROLE_RATES_GBP };
  for (const [legacy, canonical] of Object.entries(ROLE_ALIASES)) {
    roles[legacy] = DEFAULT_ROLE_RATES_GBP[canonical];
  }

  let total = 0;
  for (const [role, rate] of Object.entries(roles)) {
    const res = await users.updateMany({ ...missing, role }, { $set: { hourly_rate: rate } });
    if (res.modifiedCount) console.log(`✅ ${role}: set ${res.modifiedCount} user(s) to £${rate}`);
    total += res.modifiedCount;
  }
  // Anything left has an unrecognised role.
  const rest = await users.updateMany(missing, { $set: { hourly_rate: FALLBACK_HOURLY_RATE_GBP } });
  if (rest.modifiedCount) {
    console.log(`✅ other roles: set ${rest.modifiedCount} user(s) to £${FALLBACK_HOURLY_RATE_GBP}`);
  }
  total += rest.modifiedCount;

  console.log(`🎉 Done — ${total} user(s) backfilled.`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
