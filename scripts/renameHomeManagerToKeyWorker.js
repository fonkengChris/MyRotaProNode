/**
 * One-off migration: rename the `home_manager` user role to `key_worker`.
 *
 * The role key was renamed across the codebase (enums, auth guards, UI labels).
 * Existing documents still carry the old value, so this updates them in place:
 *   - users.role                                (authoritative role)
 *   - timetables.accessible_by_roles[]          (role-based access list)
 *   - timetables.weekly_rotas[].shifts[].assigned_staff[].role   (denormalized snapshot)
 *
 * Usage:  MONGODB_URI=... node scripts/renameHomeManagerToKeyWorker.js
 * Idempotent: running it again after completion is a no-op.
 */
const mongoose = require('mongoose');

const OLD_ROLE = 'home_manager';
const NEW_ROLE = 'key_worker';
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';

async function run() {
  console.log('🔌 Connecting to MongoDB:', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  // 1) Users — the authoritative role value.
  const users = await db
    .collection('users')
    .updateMany({ role: OLD_ROLE }, { $set: { role: NEW_ROLE } });
  console.log(`✅ users: matched ${users.matchedCount}, updated ${users.modifiedCount}`);

  // 2) Timetables — deeply-nested snapshots. Load-modify-save so we can rewrite the
  //    role at every level (positional operators can't reach 3 nested arrays at once).
  const hasTimetables =
    (await db.listCollections({ name: 'timetables' }).toArray()).length > 0;
  if (hasTimetables) {
    const cursor = db.collection('timetables').find({});
    let scanned = 0;
    let updated = 0;
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      scanned += 1;
      let changed = false;

      if (Array.isArray(doc.accessible_by_roles)) {
        const next = doc.accessible_by_roles.map((r) => (r === OLD_ROLE ? NEW_ROLE : r));
        if (next.some((r, i) => r !== doc.accessible_by_roles[i])) {
          doc.accessible_by_roles = next;
          changed = true;
        }
      }

      for (const week of doc.weekly_rotas || []) {
        for (const shift of week.shifts || []) {
          for (const a of shift.assigned_staff || []) {
            if (a && a.role === OLD_ROLE) {
              a.role = NEW_ROLE;
              changed = true;
            }
          }
        }
      }

      if (changed) {
        await db.collection('timetables').updateOne(
          { _id: doc._id },
          {
            $set: {
              accessible_by_roles: doc.accessible_by_roles,
              weekly_rotas: doc.weekly_rotas,
            },
          }
        );
        updated += 1;
      }
    }
    console.log(`✅ timetables: scanned ${scanned}, updated ${updated}`);
  }

  await mongoose.disconnect();
  console.log('🏁 Migration complete.');
}

run().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
