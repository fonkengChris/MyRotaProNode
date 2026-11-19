/**
 * One-off backfill: link every home that has no service to the services its sibling
 * homes (same service_type) use.
 *
 * Homes created before auto-linking existed have no entry in any Service.home_ids, so
 * the weekly schedule editor shows no services for them.
 *
 * Usage:  MONGODB_URI=... node scripts/linkHomesToServices.js [--dry-run]
 * Idempotent: homes that already belong to a service are left alone.
 */
const mongoose = require('mongoose');
const Home = require('../models/Home');
const Service = require('../models/Service');
const { linkHomeToPeerServices } = require('../utils/homeServices');

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';
const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  console.log('🔌 Connecting to MongoDB:', MONGODB_URI.replace(/\/\/[^@/]*@/, '//***@'));
  await mongoose.connect(MONGODB_URI);

  const linked = new Set((await Service.distinct('home_ids')).map(String));
  const orphans = (await Home.find({}, 'name service_type')).filter(h => !linked.has(String(h._id)));
  console.log(`Found ${orphans.length} home(s) with no service${DRY_RUN ? ' (dry run)' : ''}.`);

  for (const home of orphans) {
    if (DRY_RUN) {
      console.log(`• ${home.name} [${home.service_type}]`);
      continue;
    }
    const names = await linkHomeToPeerServices(home);
    console.log(names.length
      ? `✅ ${home.name} → ${names.join(', ')}`
      : `⚠️  ${home.name}: no sibling ${home.service_type} service to link to`);
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
