const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Shift = require('../models/Shift');
const mongoose = require('mongoose');
const KeyWorkerAccessSettings = require('../models/KeyWorkerAccessSettings');
const { requireRole, requireAccess, hasAccess, reachesAllHomes, canReachHome, getUserHomeIds } = require('../middleware/auth');

// Hourly pay and key worker access overrides are private: only admins see them
// (both are `select: false` on the model).
const privateFields = (req) => (req.user.role === 'admin' ? '+hourly_rate +key_worker_access' : '');

// Fields each kind of edit may set. Allowlists, so `$` operators and system fields in a
// request body never reach the database. Home changes by key workers go through the
// add-home/remove-home endpoints, which check scope.
const PROFILE_FIELDS = ['name', 'email', 'phone', 'skills', 'preferred_shift_types'];
const STAFF_FIELDS = [...PROFILE_FIELDS, 'role', 'type', 'is_active', 'min_hours_per_week', 'max_hours_per_week', 'annual_leave_entitlement_days'];
const ADMIN_FIELDS = [...STAFF_FIELDS, 'homes', 'default_home_id', 'hourly_rate'];

// The only roles a key worker may give someone; admin and key_worker are granted by admins.
const KEY_WORKER_GRANTABLE_ROLES = ['senior_staff', 'support_worker'];

const pickFields = (body, fields) => {
  const data = {};
  for (const field of fields) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return data;
};

// The staff list is also the rota's staff picker, so rota access reaches it too.
const readsAllStaff = (user) => reachesAllHomes(user, 'staff') || reachesAllHomes(user, 'rota');
const readsStaffInHome = (user, homeId) => canReachHome(user, 'staff', homeId) || canReachHome(user, 'rota', homeId);

// Why a key worker may not manage this staff member, or null when they may. Admins are off
// limits, and so is their own record (profile edits go through PUT /:id as self).
const keyWorkerTargetError = (actor, target) => {
  if (actor.role !== 'key_worker') return null;
  if (!hasAccess(actor, 'staff', 'full')) return 'Your access level does not allow this. Please ask an admin.';
  if (target.role === 'admin') return 'Only admins can manage admin accounts.';
  if (target._id.toString() === actor._id.toString()) return 'You cannot change this on your own account.';
  const reachable = reachesAllHomes(actor, 'staff') || getUserHomeIds(target).some(id => canReachHome(actor, 'staff', id));
  return reachable ? null : 'Access denied. You can only manage staff in your own home.';
};

// Deleting or deactivating another key worker takes away a role only admins can grant.
const keyWorkerRemovalError = (actor, target) => {
  const error = keyWorkerTargetError(actor, target);
  if (error) return error;
  if (actor.role === 'key_worker' && target.role === 'key_worker') return 'Only admins can remove key workers.';
  return null;
};

// Get all users (admins see everyone; everyone else is scoped to their own home(s))
router.get('/', async (req, res) => {
  try {
    const { home_id, role, type, is_active } = req.query;
    const filter = {};

    // Validate home_id if provided
    if (home_id && home_id !== 'undefined' && home_id !== 'null') {
      filter['homes.home_id'] = home_id;
    }
    // Match legacy role aliases too (e.g. home_manager rows count as key_worker).
    if (role) filter.role = User.roleQueryValue(role);
    if (type) filter.type = type;
    if (is_active !== undefined) filter.is_active = is_active === 'true';

    // Non-admins can only ever see staff who share one of their homes.
    if (req.user.role !== 'admin') {
      if (home_id && home_id !== 'undefined' && home_id !== 'null') {
        if (!readsStaffInHome(req.user, home_id)) {
          return res.status(403).json({ error: 'Access denied. You can only view staff in your own home.' });
        }
      } else if (!readsAllStaff(req.user)) {
        filter['homes.home_id'] = { $in: getUserHomeIds(req.user) };
      }
    }

    const users = await User.find(filter).select(privateFields(req));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create a new user (admins, and key workers with full staff access). Self-registration was
// removed, so this is the only way to add users to the system.
router.post('/', requireRole(['admin', 'key_worker']), requireAccess('staff'), async (req, res) => {
  try {
    const { name, email, phone, password, role, type, home_id, homes, annual_leave_entitlement_days, hourly_rate } = req.body;

    if (!name || !email || !phone || !password || !role) {
      return res.status(400).json({ error: 'Name, email, phone, password and role are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (!['admin', 'key_worker', 'senior_staff', 'support_worker'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const byKeyWorker = req.user.role === 'key_worker';
    if (byKeyWorker && !KEY_WORKER_GRANTABLE_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Only admins can create admins and key workers.' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const userData = {
      name,
      email,
      phone,
      password,
      role,
      type: type || 'fulltime'
    };

    // Optional manager-set override; otherwise the model's pre-save hook derives the
    // statutory default from `type`.
    if (annual_leave_entitlement_days !== undefined && annual_leave_entitlement_days !== null && annual_leave_entitlement_days !== '') {
      userData.annual_leave_entitlement_days = annual_leave_entitlement_days;
    }

    // Optional individual rate; otherwise the model defaults it to the role's rate.
    if (!byKeyWorker && hourly_rate !== undefined && hourly_rate !== null && hourly_rate !== '') {
      userData.hourly_rate = hourly_rate;
    }

    // Attach a home if provided (non-admin users). Accept either `home_id` or a
    // `homes` array from the client.
    const primaryHomeId = home_id
      || (Array.isArray(homes) && homes[0] && (typeof homes[0].home_id === 'string' ? homes[0].home_id : homes[0].home_id?.id));
    if (byKeyWorker && !reachesAllHomes(req.user, 'staff') && !canReachHome(req.user, 'staff', primaryHomeId)) {
      return res.status(403).json({ error: 'Access denied. You can only add staff to your own home.' });
    }
    if (role !== 'admin' && primaryHomeId) {
      userData.homes = [{ home_id: primaryHomeId, is_default: true }];
      userData.default_home_id = primaryHomeId;
    }

    const user = new User(userData);
    await user.save();

    // publicInfo strips the password before returning.
    res.status(201).json(user.publicInfo);
  } catch (error) {
    console.error('Create user error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(error.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Server error while creating user' });
  }
});

// Get user by ID (self, admin, or someone who shares a home)
router.get('/:id', async (req, res) => {
  try {
    // Validate that the ID is not undefined or invalid
    if (!req.params.id || req.params.id === 'undefined' || req.params.id === 'null') {
      return res.status(400).json({ error: 'Invalid user ID provided' });
    }

    const user = await User.findById(req.params.id).select(privateFields(req));
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Non-admins may only view themselves or staff who share one of their homes.
    if (req.user.role !== 'admin' && req.params.id !== req.user._id.toString()) {
      const reachable = readsAllStaff(req.user) || getUserHomeIds(user).some(id => readsStaffInHome(req.user, id));
      if (!reachable) {
        return res.status(403).json({ error: 'Access denied. You can only view your own data or staff in your home.' });
      }
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user (self for own profile, or admin/key_worker with full staff access)
router.put('/:id', async (req, res) => {
  try {
    const isSelf = req.params.id === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';

    if (!isAdmin && req.user.role !== 'key_worker' && !isSelf) {
      return res.status(403).json({ error: 'Access denied. You can only update your own profile.' });
    }

    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    let updateData;
    if (isAdmin) {
      updateData = pickFields(req.body, ADMIN_FIELDS);
    } else if (isSelf) {
      updateData = pickFields(req.body, PROFILE_FIELDS);
    } else {
      const targetError = keyWorkerTargetError(req.user, target);
      if (targetError) {
        return res.status(403).json({ error: targetError });
      }
      updateData = pickFields(req.body, STAFF_FIELDS);
      // The edit form always sends the role, so an unchanged one isn't a role change.
      if (updateData.role === target.role) delete updateData.role;
      if (updateData.role !== undefined && (target.role === 'key_worker' || !KEY_WORKER_GRANTABLE_ROLES.includes(updateData.role))) {
        return res.status(403).json({ error: 'Only admins can grant or change the admin and key worker roles.' });
      }
      if (updateData.is_active === false && target.is_active && target.role === 'key_worker') {
        return res.status(403).json({ error: 'Only admins can remove key workers.' });
      }
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).select(privateFields(req));

    res.json(user);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(error.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Set a key worker's access overrides (admin only). Empty values use the org setting.
router.put('/:id/key-worker-access', requireRole(['admin']), async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.role !== 'key_worker') {
      return res.status(400).json({ error: 'Access overrides only apply to key workers' });
    }

    const overrides = {};
    for (const [field, values] of Object.entries(KeyWorkerAccessSettings.FIELD_VALUES)) {
      const value = req.body[field];
      if (value === undefined || value === null || value === '') continue;
      if (!values.includes(value)) {
        return res.status(400).json({ error: `Invalid value for ${field}` });
      }
      overrides[field] = value;
    }

    target.key_worker_access = overrides;
    await target.save();
    res.json({ key_worker_access: overrides });
  } catch (error) {
    console.error('Update key worker access overrides error:', error);
    res.status(500).json({ error: 'Failed to update key worker access' });
  }
});

// Delete user (admins, and key workers with full staff access)
router.delete('/:id', requireRole(['admin', 'key_worker']), requireAccess('staff'), async (req, res) => {
  try {
    const userId = req.params.id
    if (mongoose.Types.ObjectId.isValid(userId)) {
      const target = await User.findById(userId).select('role homes');
      const removalError = target && keyWorkerRemovalError(req.user, target);
      if (removalError) {
        return res.status(403).json({ error: removalError });
      }
    }
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId

    // Cascade cleanup: remove deleted user from any shift assignments.
    // Without this, existing shifts can keep `assigned_staff` entries referencing non-existent users,
    // which renders as "Unknown Staff" in the rota UI.
    await Shift.updateMany(
      { 'assigned_staff.user_id': userIdObj },
      { $pull: { assigned_staff: { user_id: userIdObj } } }
    )

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Deactivate user
router.post('/:id/deactivate', requireRole(['admin', 'key_worker']), requireAccess('staff'), async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select('role homes');
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    const removalError = keyWorkerRemovalError(req.user, target);
    if (removalError) {
      return res.status(403).json({ error: removalError });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { is_active: false },
      { new: true }
    );
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// Add home to user
router.post('/:id/add-home', requireRole(['admin', 'key_worker']), requireAccess('staff'), async (req, res) => {
  try {
    const { home_id, is_default = false } = req.body;
    
    if (!home_id) {
      return res.status(400).json({ error: 'Home ID is required' });
    }
    
    // Check if home exists
    const Home = require('../models/Home');
    const home = await Home.findById(home_id);
    if (!home) {
      return res.status(404).json({ error: 'Home not found' });
    }
    
    // Get user and add home
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetError = keyWorkerTargetError(req.user, user);
    if (targetError) {
      return res.status(403).json({ error: targetError });
    }
    if (req.user.role === 'key_worker' && !canReachHome(req.user, 'staff', home_id)) {
      return res.status(403).json({ error: 'Access denied. You can only allocate staff to your own home.' });
    }
    
    user.addHome(home_id, is_default);
    await user.save();
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add home to user' });
  }
});

// Remove home from user
router.delete('/:id/remove-home/:homeId', requireRole(['admin', 'key_worker']), requireAccess('staff'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetError = keyWorkerTargetError(req.user, user);
    if (targetError) {
      return res.status(403).json({ error: targetError });
    }
    if (req.user.role === 'key_worker' && !canReachHome(req.user, 'staff', req.params.homeId)) {
      return res.status(403).json({ error: 'Access denied. You can only change allocations for your own home.' });
    }
    
    const removed = user.removeHome(req.params.homeId);
    if (!removed) {
      return res.status(400).json({ error: 'Home not found in user\'s homes' });
    }
    
    await user.save();
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove home from user' });
  }
});

// Set default home for user
router.post('/:id/set-default-home', requireRole(['admin', 'key_worker']), requireAccess('staff'), async (req, res) => {
  try {
    const { home_id } = req.body;
    
    if (!home_id) {
      return res.status(400).json({ error: 'Home ID is required' });
    }
    
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const targetError = keyWorkerTargetError(req.user, user);
    if (targetError) {
      return res.status(403).json({ error: targetError });
    }

    // Check if user has this home
    const hasHome = user.homes.some(home => home.home_id.toString() === home_id);
    if (!hasHome) {
      return res.status(400).json({ error: 'User does not have access to this home' });
    }
    
    user.addHome(home_id, true);
    await user.save();
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to set default home for user' });
  }
});

// Get users by home
router.get('/by-home/:homeId', async (req, res) => {
  try {
    // Non-admins can only list staff for a home they belong to.
    if (req.user.role !== 'admin' && !readsStaffInHome(req.user, req.params.homeId)) {
      return res.status(403).json({ error: 'Access denied. You can only view staff in your own home.' });
    }
    const users = await User.find({ 'homes.home_id': req.params.homeId });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users by home' });
  }
});

module.exports = router;
