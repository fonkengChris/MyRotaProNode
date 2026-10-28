const express = require('express');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/User');
const ServiceUser = require('../models/ServiceUser');
const { getUserHomeIds } = require('../middleware/auth');

const router = express.Router();

// Who a user may message. Admins reach everyone. Everyone else reaches management
// (admins), staff attached to one of their homes, and key workers whose service
// users live in one of those homes. Key workers' own homes already include their
// service users' homes (getUserHomeIds), so the rule stays symmetric.
async function messageableFilter(viewer) {
  const base = { is_active: true, _id: { $ne: viewer._id } };
  if (viewer.role === 'admin') return base;

  const homeIds = getUserHomeIds(viewer);
  const keyWorkerIds = homeIds.length
    ? await ServiceUser.distinct('key_worker_ids', { home_id: { $in: homeIds }, is_active: true })
    : [];
  return {
    ...base,
    $or: [
      { role: User.roleQueryValue('admin') },
      { 'homes.home_id': { $in: homeIds } },
      { _id: { $in: keyWorkerIds } },
    ],
  };
}

// Subset of the given user ids the viewer may message, as a Set of id strings.
async function messageableIds(viewer, ids) {
  const filter = await messageableFilter(viewer);
  const allowed = await User.find({ $and: [filter, { _id: { $in: ids } }] }).select('_id').lean();
  return new Set(allowed.map((u) => String(u._id)));
}

const toIso = (d) => (d ? new Date(d).toISOString() : null);

function serializeMessage(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  const deleted = Boolean(o.deleted_at);
  return {
    id: String(o._id),
    from_user_id: String(o.from_user_id),
    to_user_id: String(o.to_user_id),
    body: deleted ? '' : o.body,
    read_at: toIso(o.read_at),
    created_at: toIso(o.created_at),
    edited_at: deleted ? null : toIso(o.edited_at),
    deleted_at: toIso(o.deleted_at),
  };
}

// Messages created before soft delete existed have no deleted_at field at all.
const isDeletedExpr = { $ne: [{ $ifNull: ['$deleted_at', null] }, null] };

function serializeUserBrief(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
  };
}

// People the current user may start a conversation with
router.get('/recipients', async (req, res) => {
  try {
    const users = await User.find(await messageableFilter(req.user))
      .select('name email role')
      .sort({ name: 1 })
      .lean();
    res.json(users.map(serializeUserBrief));
  } catch (error) {
    console.error('Error listing message recipients:', error);
    res.status(500).json({ error: 'Failed to load recipients' });
  }
});

// List conversation summaries for the current user
router.get('/conversations', async (req, res) => {
  try {
    const myId = req.user._id;

    const rows = await Message.aggregate([
      {
        $match: {
          $or: [{ from_user_id: myId }, { to_user_id: myId }],
        },
      },
      {
        $addFields: {
          otherUserId: {
            $cond: [{ $eq: ['$from_user_id', myId] }, '$to_user_id', '$from_user_id'],
          },
          isUnreadForMe: {
            $and: [
              { $eq: ['$to_user_id', myId] },
              { $eq: ['$read_at', null] },
              { $not: [isDeletedExpr] },
            ],
          },
        },
      },
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id: '$otherUserId',
          last_body: { $first: '$body' },
          last_at: { $first: '$created_at' },
          last_from_me: { $first: { $eq: ['$from_user_id', myId] } },
          last_deleted: { $first: isDeletedExpr },
          unread_count: { $sum: { $cond: ['$isUnreadForMe', 1, 0] } },
        },
      },
      { $sort: { last_at: -1 } },
    ]);

    const otherIds = rows.map((r) => r._id);
    const users = await User.find({ _id: { $in: otherIds } })
      .select('name email role is_active')
      .lean();

    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const allowed = await messageableIds(req.user, otherIds);

    const conversations = rows
      .map((r) => {
        const u = userMap.get(String(r._id));
        if (!u || !allowed.has(String(u._id))) return null;
        return {
          other_user: serializeUserBrief(u),
          last_body: r.last_deleted ? '' : r.last_body,
          last_deleted: r.last_deleted,
          last_at: r.last_at.toISOString(),
          last_from_me: r.last_from_me,
          unread_count: r.unread_count,
        };
      })
      .filter(Boolean);

    res.json(conversations);
  } catch (error) {
    console.error('Error listing conversations:', error);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

// Messages between current user and another user (marks incoming as read)
router.get('/thread/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const partner = await User.findById(userId).select('name email role is_active');
    if (!partner) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!(await messageableIds(req.user, [partner._id])).has(String(partner._id))) {
      return res.status(403).json({ error: 'You cannot message this user' });
    }

    const me = req.user._id;
    const them = partner._id;

    await Message.updateMany(
      { from_user_id: them, to_user_id: me, read_at: null },
      { $set: { read_at: new Date() } }
    );

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const messages = await Message.find({
      $or: [
        { from_user_id: me, to_user_id: them },
        { from_user_id: them, to_user_id: me },
      ],
    })
      .sort({ created_at: 1 })
      .limit(limit)
      .lean();

    const serialized = messages.map(serializeMessage);

    res.json({
      other_user: serializeUserBrief(partner),
      messages: serialized,
    });
  } catch (error) {
    console.error('Error loading thread:', error);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Send a message
router.post('/', async (req, res) => {
  try {
    const { to_user_id, body } = req.body;
    if (!to_user_id || typeof body !== 'string') {
      return res.status(400).json({ error: 'to_user_id and body are required' });
    }
    const trimmed = body.trim();
    if (!trimmed) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    if (!mongoose.Types.ObjectId.isValid(to_user_id)) {
      return res.status(400).json({ error: 'Invalid recipient' });
    }

    const recipient = await User.findById(to_user_id).select('name email role is_active');
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (!(await messageableIds(req.user, [recipient._id])).has(String(recipient._id))) {
      return res.status(403).json({ error: 'You cannot message this user' });
    }

    const msg = await Message.create({
      from_user_id: req.user._id,
      to_user_id: recipient._id,
      body: trimmed,
      read_at: null,
    });

    res.status(201).json(serializeMessage(msg));
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Loads a message the current user sent, or responds with the right error.
async function findOwnMessage(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid message id' });
    return null;
  }
  const msg = await Message.findById(id);
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return null;
  }
  if (!msg.from_user_id.equals(req.user._id)) {
    res.status(403).json({ error: 'You can only change messages you sent' });
    return null;
  }
  if (msg.deleted_at) {
    res.status(410).json({ error: 'This message has been deleted' });
    return null;
  }
  return msg;
}

// Edit a message you sent
router.patch('/:id', async (req, res) => {
  try {
    const { body } = req.body;
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }
    const msg = await findOwnMessage(req, res);
    if (!msg) return;

    const trimmed = body.trim();
    if (trimmed !== msg.body) {
      msg.body = trimmed;
      msg.edited_at = new Date();
      await msg.save();
    }
    res.json(serializeMessage(msg));
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(error.errors)[0].message });
    }
    console.error('Error editing message:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Delete a message you sent (for both people in the conversation)
router.delete('/:id', async (req, res) => {
  try {
    const msg = await findOwnMessage(req, res);
    if (!msg) return;

    msg.deleted_at = new Date();
    await msg.save();
    res.json(serializeMessage(msg));
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Send the same message to several users at once. Each recipient gets their own
// direct message, so replies land in the normal one-to-one threads.
const MAX_BULK_RECIPIENTS = 200;

router.post('/bulk', async (req, res) => {
  try {
    const { to_user_ids, body } = req.body;
    if (!Array.isArray(to_user_ids) || to_user_ids.length === 0 || typeof body !== 'string') {
      return res.status(400).json({ error: 'to_user_ids (non-empty array) and body are required' });
    }
    const trimmed = body.trim();
    if (!trimmed) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    const uniqueIds = [...new Set(to_user_ids.map(String))];
    if (uniqueIds.length > MAX_BULK_RECIPIENTS) {
      return res.status(400).json({ error: `You can message at most ${MAX_BULK_RECIPIENTS} people at once` });
    }
    if (!uniqueIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ error: 'Invalid recipient' });
    }

    const recipients = await User.find({ _id: { $in: uniqueIds } }).select('name email role is_active');
    if (recipients.length !== uniqueIds.length) {
      return res.status(404).json({ error: 'One or more recipients were not found' });
    }

    const allowed = await messageableIds(req.user, uniqueIds);
    const blocked = recipients.filter((r) => !allowed.has(String(r._id)));
    if (blocked.length) {
      return res.status(403).json({
        error: `You cannot message: ${blocked.map((r) => r.name).join(', ')}`,
      });
    }

    const docs = await Message.insertMany(
      recipients.map((r) => ({
        from_user_id: req.user._id,
        to_user_id: r._id,
        body: trimmed,
        read_at: null,
      }))
    );

    res.status(201).json({ sent: docs.length, messages: docs.map(serializeMessage) });
  } catch (error) {
    console.error('Error sending bulk message:', error);
    res.status(500).json({ error: 'Failed to send messages' });
  }
});

module.exports = router;
