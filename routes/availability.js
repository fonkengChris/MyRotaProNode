const express = require('express');
const router = express.Router();
const Availability = require('../models/Availability');
const User = require('../models/User');
const TimeOffRequest = require('../models/TimeOffRequest');
const { hasAccess, reachesAllHomes, canReachHome, getUserHomeIds } = require('../middleware/auth');

// Admins manage anyone's availability; key workers with full staff access manage other staff
// in their scope; part-time/bank staff manage only their own.
const canManageAvailabilityFor = async (actor, targetUserId) => {
  if (actor.role === 'admin') return true;
  const isSelf = String(targetUserId) === actor._id.toString();
  if (isSelf) return ['parttime', 'bank'].includes(actor.type);
  if (actor.role !== 'key_worker' || !hasAccess(actor, 'staff')) return false;
  const target = await User.findById(targetUserId).select('role homes');
  if (!target || target.role === 'admin') return false;
  return reachesAllHomes(actor, 'staff') || getUserHomeIds(target).some(id => canReachHome(actor, 'staff', id));
};

// Everyone sees their own availability; admins see everyone's; key workers with at least view
// staff access see non-admin staff in their scope.
const canViewAvailabilityFor = async (actor, targetUserId) => {
  if (actor.role === 'admin' || String(targetUserId) === actor._id.toString()) return true;
  if (actor.role !== 'key_worker' || !hasAccess(actor, 'staff', 'view')) return false;
  const target = await User.findById(targetUserId).select('role homes');
  if (!target || target.role === 'admin') return false;
  return reachesAllHomes(actor, 'staff') || getUserHomeIds(target).some(id => canReachHome(actor, 'staff', id));
};

// The user IDs whose availability the actor may list, or null for no restriction.
const viewableUserIds = async (actor) => {
  if (actor.role === 'admin') return null;
  if (actor.role !== 'key_worker' || !hasAccess(actor, 'staff', 'view')) return [actor._id];
  const filter = { role: { $ne: 'admin' } };
  if (!reachesAllHomes(actor, 'staff')) filter['homes.home_id'] = { $in: getUserHomeIds(actor) };
  const ids = await User.find(filter).distinct('_id');
  return [actor._id, ...ids];
};

// Days covered by approved leave belong to the leave: approving it marks them unavailable and
// cancelling it (admin-only) is the way to free them, so nobody edits them directly.
const onApprovedLeave = async (userId, ...dates) => {
  const days = dates.filter(Boolean);
  if (!days.length) return false;
  return TimeOffRequest.exists({
    user_id: userId,
    status: 'approved',
    $or: days.map(date => ({ start_date: { $lte: date }, end_date: { $gte: date } }))
  });
};

const leaveLocked = (res) => res.status(409).json({
  error: 'This day is approved leave. Cancel the leave to change its availability.',
  code: 'AVAILABILITY_ON_LEAVE'
});

const forbidden = (res, actor) => res.status(403).json({
  error: actor.type === 'fulltime' && actor.role !== 'admin'
    ? 'Your availability is managed by an admin'
    : 'You can only manage your own availability',
  code: 'AVAILABILITY_FORBIDDEN'
});

// Get all availability records
router.get('/', async (req, res) => {
  try {
    const { user_id, date, start_date, end_date } = req.query;
    const filter = {};

    if (user_id) {
      if (!(await canViewAvailabilityFor(req.user, user_id))) {
        return res.status(403).json({ error: 'You cannot view this availability', code: 'AVAILABILITY_FORBIDDEN' });
      }
      filter.user_id = user_id;
    } else {
      const ids = await viewableUserIds(req.user);
      if (ids) filter.user_id = { $in: ids };
    }
    if (date) filter.date = date;
    if (start_date || end_date) {
      filter.date = {};
      if (start_date) filter.date.$gte = start_date;
      if (end_date) filter.date.$lte = end_date;
    }
    
    const availabilities = await Availability.find(filter).populate('user_id', 'name');
    res.json(availabilities);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability records' });
  }
});

// Get availability by ID
router.get('/:id', async (req, res) => {
  try {
    const availability = await Availability.findById(req.params.id).populate('user_id', 'name');
    // Out-of-scope records 404 too, so their existence isn't revealed.
    if (!availability || !(await canViewAvailabilityFor(req.user, availability.user_id && availability.user_id._id))) {
      return res.status(404).json({ error: 'Availability record not found' });
    }
    res.json(availability);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability record' });
  }
});

// Create new availability
router.post('/', async (req, res) => {
  try {
    if (!(await canManageAvailabilityFor(req.user, req.body.user_id))) {
      return forbidden(res, req.user);
    }
    if (await onApprovedLeave(req.body.user_id, req.body.date)) {
      return leaveLocked(res);
    }

    const { pre_leave, ...body } = req.body;

    // One record per user and date: posting again replaces that day's entry. Saved through the
    // document (not findOneAndUpdate) so the status rules in the model's validate hook run.
    const existingAvailability = await Availability.findOne({
      user_id: body.user_id,
      date: body.date
    });

    if (existingAvailability) {
      existingAvailability.set(body);
      await existingAvailability.save();
      res.json(existingAvailability);
    } else {
      const availability = new Availability(body);
      await availability.save();
      res.status(201).json(availability);
    }
  } catch (error) {
    console.error('❌ Error creating/updating availability:', error);
    console.error('❌ Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      errors: error.errors
    });
    res.status(400).json({ 
      error: 'Failed to create/update availability record',
      details: error.message,
      validationErrors: error.errors
    });
  }
});

// Update availability
router.put('/:id', async (req, res) => {
  try {
    const existing = await Availability.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Availability record not found' });
    }
    if (!(await canManageAvailabilityFor(req.user, existing.user_id))) {
      return forbidden(res, req.user);
    }

    // A record can't be reassigned to another staff member.
    const { user_id, pre_leave, ...updates } = req.body;
    if (await onApprovedLeave(existing.user_id, existing.date, updates.date)) {
      return leaveLocked(res);
    }
    existing.set(updates);
    await existing.save();

    res.json(existing);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update availability record', details: error.message });
  }
});

// Delete availability
router.delete('/:id', async (req, res) => {
  try {
    const availability = await Availability.findById(req.params.id);
    if (!availability) {
      return res.status(404).json({ error: 'Availability record not found' });
    }
    if (!(await canManageAvailabilityFor(req.user, availability.user_id))) {
      return forbidden(res, req.user);
    }
    if (await onApprovedLeave(availability.user_id, availability.date)) {
      return leaveLocked(res);
    }
    await availability.deleteOne();
    res.json({ message: 'Availability record deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete availability record' });
  }
});

// Get user availability for a date range
router.get('/user/:userId', async (req, res) => {
  try {
    if (!(await canViewAvailabilityFor(req.user, req.params.userId))) {
      return res.status(403).json({ error: 'You cannot view this availability', code: 'AVAILABILITY_FORBIDDEN' });
    }
    const { start_date, end_date } = req.query;
    const filter = { user_id: req.params.userId };
    
    if (start_date || end_date) {
      filter.date = {};
      if (start_date) filter.date.$gte = start_date;
      if (end_date) filter.date.$lte = end_date;
    }
    
    const availabilities = await Availability.find(filter);
    res.json(availabilities);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user availability' });
  }
});

module.exports = router;
