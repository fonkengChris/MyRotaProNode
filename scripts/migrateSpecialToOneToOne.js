/**
 * One-off migration: replace the `special` ("Special (1:1 support)") shift type with
 * the new `one_to_one` type.
 *
 * 1-to-1 shifts are created per service user by admins and never come from weekly
 * templates, so:
 *   - shifts.shift_type 'special'                       → 'one_to_one'
 *     (service_user_id stays null: listed below so an admin can link each one; the
 *      model only enforces the link when a shift is created or its type/link changes)
 *   - weeklyschedules.schedule.<day>.shifts[] 'special' → removed (listed below)
 *   - users.preferred_shift_types 'special'             → 'one_to_one'
 *   - availabilities.preferred_shift_type 'special'     → 'one_to_one'
 *   - timetables.weekly_rotas[].shifts[].shift_type     → 'one_to_one' (snapshots)
 *
 * Usage:  MONGODB_URI=... node scripts/migrateSpecialToOneToOne.js [--dry-run]
 * Idempotent: running it again after completion is a no-op.
 */
const mongoose = require('mongoose');

const OLD_TYPE = 'special';
const NEW_TYPE = 'one_to_one';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';
const DRY_RUN = process.argv.includes('--dry-run');

async function hasCollection(db, name) {
  return (await db.listCollections({ name }).toArray()).length > 0;
}

// Replace OLD_TYPE with NEW_TYPE in a string array field (deduplicated).
async function renameInArrayField(db, collection, field) {
  if (!(await hasCollection(db, collection))) return;
  const filter = { [field]: OLD_TYPE };
  const count = await db.collection(collection).countDocuments(filter);
  if (!DRY_RUN && count) {
    await db.collection(collection).updateMany(filter, { $addToSet: { [field]: NEW_TYPE } });
    await db.collection(collection).updateMany(filter, { $pull: { [field]: OLD_TYPE } });
  }
  console.log(`✅ ${collection}.${field}: ${count} document(s) ${DRY_RUN ? 'to update' : 'updated'}`);
}

async function run() {
  console.log(`🔌 Connecting to MongoDB: ${MONGODB_URI}${DRY_RUN ? ' (dry run)' : ''}`);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  // 1) Shifts.
  const specialShifts = await db
    .collection('shifts')
    .find({ shift_type: OLD_TYPE })
    .project({ home_id: 1, date: 1, start_time: 1, end_time: 1 })
    .toArray();
  if (!DRY_RUN && specialShifts.length) {
    await db
      .collection('shifts')
      .updateMany({ shift_type: OLD_TYPE }, { $set: { shift_type: NEW_TYPE, service_user_id: null } });
  }
  console.log(`✅ shifts: ${specialShifts.length} 'special' shift(s) ${DRY_RUN ? 'to convert' : 'converted'} to '${NEW_TYPE}'`);
  for (const s of specialShifts) {
    console.log(`   ↳ link a service user: shift ${s._id} home ${s.home_id} ${s.date} ${s.start_time}-${s.end_time}`);
  }

  // 2) Weekly schedule templates: 1-to-1s are never templated, so drop the patterns.
  if (await hasCollection(db, 'weeklyschedules')) {
    const cursor = db.collection('weeklyschedules').find({});
    let removed = 0;
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const $set = {};
      for (const day of DAYS) {
        const shifts = doc.schedule?.[day]?.shifts;
        if (!Array.isArray(shifts)) continue;
        const kept = shifts.filter((p) => p.shift_type !== OLD_TYPE);
        if (kept.length === shifts.length) continue;
        for (const p of shifts.filter((p) => p.shift_type === OLD_TYPE)) {
          console.log(`   ↳ removing template pattern: home ${doc.home_id} ${day} ${p.start_time}-${p.end_time}`);
          removed += 1;
        }
        $set[`schedule.${day}.shifts`] = kept;
      }
      if (!DRY_RUN && Object.keys($set).length) {
        await db.collection('weeklyschedules').updateOne({ _id: doc._id }, { $set });
      }
    }
    console.log(`✅ weeklyschedules: ${removed} 'special' pattern(s) ${DRY_RUN ? 'to remove' : 'removed'}`);
  }

  // 3) Preference lists.
  await renameInArrayField(db, 'users', 'preferred_shift_types');
  if (await hasCollection(db, 'availabilities')) {
    const filter = { preferred_shift_type: OLD_TYPE };
    const count = await db.collection('availabilities').countDocuments(filter);
    if (!DRY_RUN && count) {
      await db.collection('availabilities').updateMany(filter, { $set: { preferred_shift_type: NEW_TYPE } });
    }
    console.log(`✅ availabilities.preferred_shift_type: ${count} document(s) ${DRY_RUN ? 'to update' : 'updated'}`);
  }

  // 4) Timetable snapshots (plain strings, kept consistent for display).
  if (await hasCollection(db, 'timetables')) {
    const cursor = db.collection('timetables').find({ 'weekly_rotas.shifts.shift_type': OLD_TYPE });
    let updated = 0;
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      for (const week of doc.weekly_rotas || []) {
        for (const shift of week.shifts || []) {
          if (shift.shift_type === OLD_TYPE) shift.shift_type = NEW_TYPE;
        }
      }
      if (!DRY_RUN) {
        await db
          .collection('timetables')
          .updateOne({ _id: doc._id }, { $set: { weekly_rotas: doc.weekly_rotas } });
      }
      updated += 1;
    }
    console.log(`✅ timetables: ${updated} document(s) ${DRY_RUN ? 'to update' : 'updated'}`);
  }

  await mongoose.disconnect();
  console.log(DRY_RUN ? '🏁 Dry run complete — no changes written.' : '🏁 Migration complete.');
}

run().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
