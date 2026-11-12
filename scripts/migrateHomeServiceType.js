/**
 * One-off migration: give every home a `service_type`.
 *
 * Homes had no service type before. Community outreach homes now get a shorter minimum rest
 * between their shifts (SolverSettings.outreach_min_rest_hours), so homes whose name contains
 * "outreach" become `community_outreach`, and every other home `supported_living`. Admins can
 * correct any home afterwards in the home's edit dialog.
 *
 * Usage:  MONGODB_URI=... node scripts/migrateHomeServiceType.js [--dry-run]
 * Idempotent: homes that already have a service_type are left alone.
 */
const mongoose = require('mongoose');

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';
const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log('🔌 Connecting to MongoDB:', MONGODB_URI.replace(/\/\/[^@/]*@/, '//***@'));
  await mongoose.connect(MONGODB_URI);
  const homes = mongoose.connection.db.collection('homes');
  const missing = { service_type: { $exists: false } };
  const outreach = { ...missing, name: { $regex: 'outreach', $options: 'i' } };

  if (DRY_RUN) {
    const names = await homes.find(outreach).project({ name: 1 }).toArray();
    console.log(`🔎 Would mark ${names.length} home(s) community_outreach:`, names.map((h) => h.name).join(', ') || '(none)');
    console.log(`🔎 Would mark ${(await homes.countDocuments(missing)) - names.length} other home(s) supported_living`);
  } else {
    const o = await homes.updateMany(outreach, { $set: { service_type: 'community_outreach' } });
    const rest = await homes.updateMany(missing, { $set: { service_type: 'supported_living' } });
    console.log(`✅ community_outreach: ${o.modifiedCount}, supported_living: ${rest.modifiedCount}`);
  }

  console.log('🎉 Done.');
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
