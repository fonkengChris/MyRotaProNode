/**
 * One-off migration: give every availability record a `status`.
 *
 * Records used to be is_available + a start/end time that the solver only treated as a
 * preference. They are now available / unavailable / partial, and only partial days keep
 * (and are held to) a time window. Unavailable records become `unavailable`; available ones
 * become `available` with their old times dropped, so nobody's rostering gets stricter until
 * they choose "Partial". Entries set aside under approved leave (`pre_leave`) get the same.
 *
 * Usage:  MONGODB_URI=... node scripts/migrateAvailabilityStatus.js [--dry-run]
 * Idempotent: records that already have a status are left alone.
 */
const mongoose = require('mongoose');

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';
const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log('🔌 Connecting to MongoDB:', MONGODB_URI.replace(/\/\/[^@/]*@/, '//***@'));
  await mongoose.connect(MONGODB_URI);
  const availabilities = mongoose.connection.db.collection('availabilities');
  const missing = { status: { $exists: false } };

  const unavailable = { ...missing, is_available: false };
  const available = { ...missing, is_available: { $ne: false } };
  const preLeaveMissing = { pre_leave: { $exists: true, $ne: null }, 'pre_leave.status': { $exists: false } };

  if (DRY_RUN) {
    console.log(`🔎 Would mark ${await availabilities.countDocuments(unavailable)} record(s) unavailable`);
    console.log(`🔎 Would mark ${await availabilities.countDocuments(available)} record(s) available`);
    console.log(`🔎 Would update ${await availabilities.countDocuments(preLeaveMissing)} set-aside leave entr(ies)`);
  } else {
    const u = await availabilities.updateMany(unavailable, {
      $set: { status: 'unavailable' }, $unset: { start_time: '', end_time: '' }
    });
    const a = await availabilities.updateMany(available, {
      $set: { status: 'available', is_available: true }, $unset: { start_time: '', end_time: '' }
    });
    const p1 = await availabilities.updateMany({ ...preLeaveMissing, 'pre_leave.is_available': false }, {
      $set: { 'pre_leave.status': 'unavailable' }, $unset: { 'pre_leave.start_time': '', 'pre_leave.end_time': '' }
    });
    const p2 = await availabilities.updateMany(preLeaveMissing, {
      $set: { 'pre_leave.status': 'available' }, $unset: { 'pre_leave.start_time': '', 'pre_leave.end_time': '' }
    });
    console.log(`✅ unavailable: ${u.modifiedCount}, available: ${a.modifiedCount}, set-aside entries: ${p1.modifiedCount + p2.modifiedCount}`);
  }

  console.log('🎉 Done.');
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
