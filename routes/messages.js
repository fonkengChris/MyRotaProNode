const express = require('express');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/User');

const router = express.Router();

function homeIdSet(user) {
  const set = new Set();
  if (!user.homes || !user.homes.length) return set;
  for (const h of user.homes) {
    if (h.home_id) set.add(h.home_id.toString());
  }
  return set;
}

function sharesAnyHome(a, b) {
  const aIds = homeIdSet(a);
  if (!aIds.size) return false;
  if (!b.homes || !b.homes.length) return false;
  return b.homes.some((h) => h.home_id && aIds.has(h.home_id.toString()));
}

function canExchangeMessages(viewer, target) {
  if (!target || !target.is_active) return false;
  if (viewer._id.equals(target._id)) return false;
  if (viewer.role === 'admin') return true;
  return sharesAnyHome(viewer, target);
}

function serializeMessage(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id),
    from_user_id: String(o.from_user_id),
    to_user_id: String(o.to_user_id),
    body: o.body,
    read_at: o.read_at ? o.read_at.toISOString() : null,
    created_at: o.created_at ? o.created_at.toISOString() : null,
  };
}

function serializeUserBrief(u) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
  };
}

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
            $and: [{ $eq: ['$to_user_id', myId] }, { $eq: ['$read_at', null] }],
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

    const conversations = rows
      .map((r) => {
        const u = userMap.get(String(r._id));
        if (!u || !u.is_active) return null;
        if (!canExchangeMessages(req.user, u)) return null;
        return {
          other_user: serializeUserBrief(u),
          last_body: r.last_body,
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

    const partner = await User.findById(userId).select('name email role is_active homes');
    if (!partner) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!canExchangeMessages(req.user, partner)) {
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

    const serialized = messages.map((m) => ({
      id: String(m._id),
      from_user_id: String(m.from_user_id),
      to_user_id: String(m.to_user_id),
      body: m.body,
      read_at: m.read_at ? new Date(m.read_at).toISOString() : null,
      created_at: m.created_at ? new Date(m.created_at).toISOString() : null,
    }));

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

    const recipient = await User.findById(to_user_id).select('name email role is_active homes');
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (!canExchangeMessages(req.user, recipient)) {
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

module.exports = router;
