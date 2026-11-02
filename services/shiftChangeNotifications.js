/**
 * Tells staff when their shifts change, over the same two channels as attendance alerts:
 * an in-app Message from whoever made the change, plus a best-effort Web Push.
 *
 * Changes are coalesced per (actor, staff member) for a few seconds, so a bulk action (the
 * solver, "clear rota", deleting a timetable) gives each person one summary rather than one
 * message per shift. Nobody is told about their own action, or about shifts already over.
 */
const moment = require('moment-timezone');
const User = require('../models/User');
const Home = require('../models/Home');
const Shift = require('../models/Shift');
const { safeSendMessage } = require('./attendanceNotifications');
const { sendPushToUser } = require('./pushService');
const { shiftEndDate } = require('../utils/shiftTime');

const COALESCE_MS = 5000;
const MAX_LINES = 30;
const KIND_LABELS = {
  assigned: 'Assigned',
  removed: 'Removed',
  changed: 'Changed',
  cancelled: 'Cancelled',
  reinstated: 'Reinstated',
  approved: 'Approved',
};
// Edits to these fields change what the staff member actually has to work.
const NOTIFIABLE_FIELDS = ['date', 'start_time', 'end_time', 'shift_type', 'home_id', 'service_user_id'];

const pending = new Map();

const idOf = (value) => String((value && value._id) || value || '');

function snapshot(shift) {
  return {
    date: shift.date,
    start_time: shift.start_time,
    end_time: shift.end_time,
    shift_type: shift.shift_type,
    home_id: idOf(shift.home_id),
  };
}

function describeShift(shift, homeNames) {
  const day = moment(shift.date, 'YYYY-MM-DD').format('ddd D MMM');
  const type = shift.shift_type === 'one_to_one' ? '1-to-1' : String(shift.shift_type).replace(/[-_]/g, ' ');
  const home = homeNames.get(shift.home_id);
  return `${day}, ${shift.start_time}–${shift.end_time} (${type})${home ? ` at ${home}` : ''}`;
}

function describeChange(change, homeNames) {
  const now = describeShift(change.shift, homeNames);
  const was = change.previous && describeShift(change.previous, homeNames);
  return `${KIND_LABELS[change.kind]}: ${now}${was && was !== now ? ` (was ${was})` : ''}`;
}

async function deliver({ actorId, userId, changes }) {
  try {
    const user = await User.findOne({ _id: userId, is_active: true }).select('_id');
    if (!user) return;

    const homeIds = changes.flatMap((c) => [c.shift.home_id, c.previous && c.previous.home_id].filter(Boolean));
    const homes = await Home.find({ _id: { $in: homeIds } }).select('name').lean();
    const homeNames = new Map(homes.map((h) => [String(h._id), h.name]));

    const sorted = [...changes].sort((a, b) =>
      `${a.shift.date} ${a.shift.start_time}`.localeCompare(`${b.shift.date} ${b.shift.start_time}`)
    );
    const lines = sorted.slice(0, MAX_LINES).map((change) => describeChange(change, homeNames));
    const extra = sorted.length - lines.length;

    let body;
    let pushBody;
    if (sorted.length === 1) {
      body = `Your rota has changed. ${lines[0]}.`;
      pushBody = lines[0];
    } else {
      body = `Your rota has changed:\n${lines.map((line) => `• ${line}`).join('\n')}`;
      if (extra > 0) body += `\n…and ${extra} more. See My Schedule for the full picture.`;
      pushBody = `${sorted.length} of your shifts have changed. Open My Schedule to see them.`;
    }

    await safeSendMessage(actorId, userId, body);
    await sendPushToUser(userId, {
      title: 'Your rota has changed',
      body: pushBody,
      url: '/my-schedule',
      tag: `shift-change-${Date.now()}`,
    });
  } catch (error) {
    console.error('[shiftChangeNotifications] Failed to notify staff member:', error.message);
  }
}

function deliverPending(key) {
  const entry = pending.get(key);
  if (!entry) return Promise.resolve();
  clearTimeout(entry.timer);
  pending.delete(key);
  return deliver(entry);
}

/**
 * Queue shift changes for delivery.
 * @param {string|ObjectId} actorId - the user who made the change (the message sender).
 * @param {Array<{userId, shift, kind, previous?}>} changes - `kind` is a KIND_LABELS key;
 *   `previous` is the shift's earlier state, for edits.
 */
function queueShiftChanges(actorId, changes) {
  const now = new Date();
  for (const { userId, shift, kind, previous } of changes) {
    if (idOf(userId) === idOf(actorId) || shiftEndDate(shift) < now) continue;

    const key = `${idOf(actorId)}:${idOf(userId)}`;
    const entry = pending.get(key) || { actorId, userId, changes: [] };
    entry.changes.push({ kind, shift: snapshot(shift), previous: previous && snapshot(previous) });
    pending.set(key, entry);

    clearTimeout(entry.timer);
    // Tests deliver explicitly via flushShiftChangeNotifications.
    if (process.env.NODE_ENV !== 'test') {
      entry.timer = setTimeout(() => deliverPending(key), COALESCE_MS);
      entry.timer.unref();
    }
  }
}

/** Queue one change of `kind` for everyone assigned to each of these (active) shifts. */
function queueForAssignees(actorId, shifts, kind) {
  queueShiftChanges(
    actorId,
    shifts
      .filter((shift) => shift.is_active !== false)
      .flatMap((shift) => (shift.assigned_staff || []).map((a) => ({ userId: a.user_id, shift, kind })))
  );
}

/** Tell a shift's assignees about an edit, given its state before and after. */
function queueShiftEdited(actorId, before, after) {
  const wasActive = before.is_active !== false;
  const isActive = after.is_active !== false;
  let kind = null;
  let previous;
  if (wasActive && !isActive) {
    kind = 'cancelled';
  } else if (!wasActive && isActive) {
    kind = 'reinstated';
  } else if (isActive && NOTIFIABLE_FIELDS.some((field) => idOf(before[field]) !== idOf(after[field]))) {
    kind = 'changed';
    previous = before;
  }
  if (!kind) return;
  queueShiftChanges(actorId, (after.assigned_staff || []).map((a) => ({ userId: a.user_id, shift: after, kind, previous })));
}

/** Tell both parties (other than whoever accepted it) that a swap has gone through. */
async function queueSwapCompleted(actorId, swap) {
  try {
    const [requesterShift, targetShift] = await Promise.all([
      Shift.findById(swap.requester_shift_id).lean(),
      Shift.findById(swap.target_shift_id).lean(),
    ]);
    if (!requesterShift || !targetShift) return;
    queueShiftChanges(actorId, [
      { userId: swap.requester_id, shift: requesterShift, kind: 'removed' },
      { userId: swap.requester_id, shift: targetShift, kind: 'assigned' },
      { userId: swap.target_user_id, shift: targetShift, kind: 'removed' },
      { userId: swap.target_user_id, shift: requesterShift, kind: 'assigned' },
    ]);
  } catch (error) {
    console.error('[shiftChangeNotifications] Failed to queue swap notification:', error.message);
  }
}

/** Deliver everything queued now, without waiting for the coalescing window. */
function flushShiftChangeNotifications() {
  return Promise.all([...pending.keys()].map(deliverPending));
}

module.exports = {
  queueShiftChanges,
  queueForAssignees,
  queueShiftEdited,
  queueSwapCompleted,
  flushShiftChangeNotifications,
};
