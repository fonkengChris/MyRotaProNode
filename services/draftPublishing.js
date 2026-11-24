const moment = require('moment-timezone');
const Shift = require('../models/Shift');
const Timetable = require('../models/Timetable');
const { queueShiftChanges } = require('./shiftChangeNotifications');

/**
 * Turn draft assignments into live allocations (see utils/draftAssignments.js).
 *
 * @param {object} shiftFilter - which shifts to touch (combined with "has a draft").
 * @param {object} draftFilter - extra arrayFilter conditions on the assignment, keyed `a.<field>`.
 * @param {string|ObjectId} actorId - the publisher; sends the "Assigned" notifications.
 * @returns {Promise<number>} how many assignments were published.
 */
async function publishDraftAssignments(shiftFilter, draftFilter, actorId) {
  const filter = { ...shiftFilter, 'assigned_staff.is_draft': true };
  const shifts = await Shift.find(filter).lean();
  if (!shifts.length) return 0;

  const matches = (a) =>
    a.is_draft === true &&
    Object.entries(draftFilter).every(([path, value]) => {
      const field = path.replace(/^a\./, '');
      return String(a[field] ?? null) === String(value ?? null);
    });

  await Shift.updateMany(
    { _id: { $in: shifts.map((s) => s._id) } },
    { $set: { 'assigned_staff.$[a].is_draft': false, 'assigned_staff.$[a].draft_timetable_id': null } },
    { arrayFilters: [{ 'a.is_draft': true, ...draftFilter }] }
  );

  const changes = shifts
    .filter((shift) => shift.is_active !== false)
    .flatMap((shift) =>
      (shift.assigned_staff || [])
        .filter(matches)
        .filter((a) => a.status !== 'declined')
        .map((a) => ({ userId: a.user_id, shift, kind: 'assigned' }))
    );
  queueShiftChanges(actorId, changes);

  return shifts.reduce((n, shift) => n + (shift.assigned_staff || []).filter(matches).length, 0);
}

/**
 * The generated-but-unpublished timetable covering any of these homes on these dates, if
 * one exists. Work done there (Rota Editor edits, Auto Generate) joins that timetable's draft.
 */
async function findUnpublishedTimetable(homeIds, startYmd, endYmd = startYmd) {
  const ids = (Array.isArray(homeIds) ? homeIds : [homeIds]).filter(Boolean);
  if (!ids.length) return null;
  return Timetable.findOne({
    status: { $in: ['draft', 'generated'] },
    generation_completed_at: { $ne: null },
    home_ids: { $in: ids },
    start_date: { $lte: new Date(`${endYmd}T23:59:59.999Z`) },
    end_date: { $gte: new Date(`${startYmd}T00:00:00.000Z`) }
  })
    .select('_id name')
    .lean();
}

/**
 * Whether a new rota-editor assignment on this shift should be a draft, and for which
 * timetable: yes inside an unpublished timetable, or when its home/week already holds
 * Auto Generate drafts. Returns null for a live assignment.
 */
async function draftContextForShift(shift) {
  const timetable = await findUnpublishedTimetable([shift.home_id], shift.date);
  if (timetable) return { is_draft: true, draft_timetable_id: timetable._id };
  const { start, end } = isoWeekRange(shift.date);
  const weekHasDrafts = await Shift.exists({
    home_id: shift.home_id,
    date: { $gte: start, $lte: end },
    'assigned_staff.is_draft': true
  });
  return weekHasDrafts ? { is_draft: true, draft_timetable_id: null } : null;
}

/** Monday–Sunday (YYYY-MM-DD) around a date. */
function isoWeekRange(ymd) {
  const day = moment.utc(ymd, 'YYYY-MM-DD');
  return {
    start: day.clone().startOf('isoWeek').format('YYYY-MM-DD'),
    end: day.clone().endOf('isoWeek').format('YYYY-MM-DD')
  };
}

module.exports = { publishDraftAssignments, findUnpublishedTimetable, draftContextForShift, isoWeekRange };
