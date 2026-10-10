const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const ServiceUser = require('../models/ServiceUser');
const Home = require('../models/Home');
const User = require('../models/User');
const { requireRole } = require('../middleware/auth');

const HOME_FIELDS = 'name location contact_info operating_hours capacity is_active';
const KEY_WORKER_FIELDS = 'name email phone role';
const STAFF_FIELDS = 'name email phone role type homes is_active';

const isValidId = (id) => !!id && id !== 'undefined' && id !== 'null' && mongoose.Types.ObjectId.isValid(id);

// Admins see every service user; key workers only those they support.
const canListServiceUsers = (req, res, next) => {
  if (!['admin', 'key_worker'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied. Only admins and key workers can view service users.' });
  }
  next();
};

// Validate and normalise home_id / key_worker_ids from a create/update payload.
// Returns { error } on failure or { data } with the cleaned fields.
async function buildServiceUserData(body, { partial = false } = {}) {
  const data = {};

  if (body.name !== undefined) data.name = body.name;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.is_active !== undefined) data.is_active = !!body.is_active;

  if (body.home_id !== undefined || !partial) {
    const homeId = body.home_id && body.home_id._id ? body.home_id._id : body.home_id;
    if (!isValidId(homeId)) return { error: 'A valid home is required' };
    if (!(await Home.exists({ _id: homeId }))) return { error: 'Home not found' };
    data.home_id = homeId;
  }

  if (body.key_worker_ids !== undefined) {
    const ids = (Array.isArray(body.key_worker_ids) ? body.key_worker_ids : [body.key_worker_ids])
      .map(id => (id && id._id ? id._id : id))
      .filter(Boolean)
      .map(String);
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.some(id => !isValidId(id))) return { error: 'Invalid key worker id' };

    // roleQueryValue also matches legacy home_manager rows that were never migrated.
    const keyWorkerCount = await User.countDocuments({
      _id: { $in: uniqueIds },
      role: User.roleQueryValue('key_worker'),
      is_active: true
    });
    if (keyWorkerCount !== uniqueIds.length) {
      return { error: 'Every assigned key worker must be an active user with the key worker role' };
    }
    data.key_worker_ids = uniqueIds;
  }

  return { data };
}

// Get service users (admins: all, filterable; key workers: their own caseload)
router.get('/', canListServiceUsers, async (req, res) => {
  try {
    const { home_id, key_worker_id, is_active } = req.query;
    const filter = {};

    if (isValidId(home_id)) filter.home_id = home_id;
    if (is_active !== undefined) filter.is_active = is_active === 'true';

    if (req.user.role === 'admin') {
      if (isValidId(key_worker_id)) filter.key_worker_ids = key_worker_id;
    } else {
      filter.key_worker_ids = req.user._id;
    }

    const serviceUsers = await ServiceUser.find(filter)
      .populate('home_id', HOME_FIELDS)
      .populate('key_worker_ids', KEY_WORKER_FIELDS)
      .sort({ name: 1 });
    res.json(serviceUsers);
  } catch (error) {
    console.error('Fetch service users error:', error);
    res.status(500).json({ error: 'Failed to fetch service users' });
  }
});

// Key worker overview: each home where their service users live, with those
// service users and the staff who work in that home.
router.get('/my-caseload', canListServiceUsers, async (req, res) => {
  try {
    let keyWorkerId = req.user._id;
    if (req.user.role === 'admin') {
      if (!isValidId(req.query.key_worker_id)) {
        return res.status(400).json({ error: 'key_worker_id is required for admins' });
      }
      keyWorkerId = req.query.key_worker_id;
    }

    const serviceUsers = await ServiceUser.find({ key_worker_ids: keyWorkerId, is_active: true })
      .populate('key_worker_ids', KEY_WORKER_FIELDS)
      .sort({ name: 1 });

    const homeIds = [...new Set(serviceUsers.map(su => su.home_id.toString()))];
    const [homes, staff] = await Promise.all([
      Home.find({ _id: { $in: homeIds } }).select(HOME_FIELDS).sort({ name: 1 }),
      User.find({ 'homes.home_id': { $in: homeIds }, is_active: true }).select(STAFF_FIELDS).sort({ name: 1 })
    ]);

    const caseload = homes.map(home => {
      const homeId = home._id.toString();
      return {
        home,
        service_users: serviceUsers.filter(su => su.home_id.toString() === homeId),
        staff: staff.filter(member => (member.homes || []).some(h => h.home_id && h.home_id.toString() === homeId))
      };
    });

    res.json(caseload);
  } catch (error) {
    console.error('Fetch caseload error:', error);
    res.status(500).json({ error: 'Failed to fetch caseload' });
  }
});

// Get service user by ID (admin, or a key worker who supports them)
router.get('/:id', canListServiceUsers, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid service user ID provided' });
    }
    const serviceUser = await ServiceUser.findById(req.params.id)
      .populate('home_id', HOME_FIELDS)
      .populate('key_worker_ids', KEY_WORKER_FIELDS);
    if (!serviceUser) {
      return res.status(404).json({ error: 'Service user not found' });
    }

    if (req.user.role !== 'admin') {
      const supports = serviceUser.key_worker_ids.some(kw => kw._id.toString() === req.user._id.toString());
      if (!supports) {
        return res.status(403).json({ error: 'Access denied. You can only view service users you support.' });
      }
    }

    res.json(serviceUser);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch service user' });
  }
});

// Create service user (admin only)
router.post('/', requireRole(['admin']), async (req, res) => {
  try {
    const { data, error } = await buildServiceUserData(req.body);
    if (error) return res.status(400).json({ error });

    const serviceUser = await ServiceUser.create(data);
    const populated = await ServiceUser.findById(serviceUser._id)
      .populate('home_id', HOME_FIELDS)
      .populate('key_worker_ids', KEY_WORKER_FIELDS);
    res.status(201).json(populated);
  } catch (error) {
    console.error('Service user creation error:', error);
    res.status(400).json({ error: 'Failed to create service user', details: error.message });
  }
});

// Update service user (admin only)
router.put('/:id', requireRole(['admin']), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid service user ID provided' });
    }
    const { data, error } = await buildServiceUserData(req.body, { partial: true });
    if (error) return res.status(400).json({ error });

    const serviceUser = await ServiceUser.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true })
      .populate('home_id', HOME_FIELDS)
      .populate('key_worker_ids', KEY_WORKER_FIELDS);
    if (!serviceUser) {
      return res.status(404).json({ error: 'Service user not found' });
    }
    res.json(serviceUser);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update service user', details: error.message });
  }
});

// Delete service user (admin only)
router.delete('/:id', requireRole(['admin']), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid service user ID provided' });
    }
    const serviceUser = await ServiceUser.findByIdAndDelete(req.params.id);
    if (!serviceUser) {
      return res.status(404).json({ error: 'Service user not found' });
    }
    res.json({ message: 'Service user deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete service user' });
  }
});

module.exports = router;
