const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Shift = require('../models/Shift');
const mongoose = require('mongoose');
const { requireRole, requireHomeAccess, getUserHomeIds } = require('../middleware/auth');

// Get all users (admins see everyone; everyone else is scoped to their own home(s))
router.get('/', async (req, res) => {
  try {
    const { home_id, role, type, is_active } = req.query;
    const filter = {};

    // Validate home_id if provided
    if (home_id && home_id !== 'undefined' && home_id !== 'null') {
      filter['homes.home_id'] = home_id;
    }
    if (role) filter.role = role;
    if (type) filter.type = type;
    if (is_active !== undefined) filter.is_active = is_active === 'true';

    // Non-admins can only ever see staff who share one of their homes.
    if (req.user.role !== 'admin') {
      const myHomeIds = getUserHomeIds(req.user);
      if (home_id && home_id !== 'undefined' && home_id !== 'null') {
        if (!myHomeIds.includes(home_id.toString())) {
          return res.status(403).json({ error: 'Access denied. You can only view staff in your own home.' });
        }
      } else {
        filter['homes.home_id'] = { $in: myHomeIds };
      }
    }

    const users = await User.find(filter);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user by ID (self, admin, or someone who shares a home)
router.get('/:id', async (req, res) => {
  try {
    // Validate that the ID is not undefined or invalid
    if (!req.params.id || req.params.id === 'undefined' || req.params.id === 'null') {
      return res.status(400).json({ error: 'Invalid user ID provided' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Non-admins may only view themselves or staff who share one of their homes.
    if (req.user.role !== 'admin' && req.params.id !== req.user._id.toString()) {
      const myHomeIds = getUserHomeIds(req.user);
      const sharesHome = getUserHomeIds(user).some(id => myHomeIds.includes(id));
      if (!sharesHome) {
        return res.status(403).json({ error: 'Access denied. You can only view your own data or staff in your home.' });
      }
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user (self for own profile, or admin/home_manager for staff in their home)
router.put('/:id', async (req, res) => {
  try {
    const isSelf = req.params.id === req.user._id.toString();
    const isManagerRole = ['admin', 'home_manager'].includes(req.user.role);

    if (!isManagerRole && !isSelf) {
      return res.status(403).json({ error: 'Access denied. You can only update your own profile.' });
    }

    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Home managers can only manage staff in their own home(s), and never admins.
    if (req.user.role === 'home_manager' && !isSelf) {
      const myHomeIds = getUserHomeIds(req.user);
      const sharesHome = getUserHomeIds(target).some(id => myHomeIds.includes(id));
      if (!sharesHome || target.role === 'admin' || req.body.role === 'admin') {
        return res.status(403).json({ error: 'Access denied. You can only manage staff in your own home.' });
      }
    }

    const { password, ...updateData } = req.body;

    // Regular users may only edit their own profile fields, never privileged ones.
    if (!isManagerRole) {
      delete updateData.role;
      delete updateData.homes;
      delete updateData.default_home_id;
      delete updateData.type;
      delete updateData.is_active;
      delete updateData.max_hours_per_week;
      delete updateData.min_hours_per_week;
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user (admin only)
router.delete('/:id', requireRole(['admin']), async (req, res) => {
  try {
    const userId = req.params.id
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
router.post('/:id/deactivate', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { is_active: false },
      { new: true }
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// Add home to user
router.post('/:id/add-home', requireRole(['admin', 'home_manager']), async (req, res) => {
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
    
    user.addHome(home_id, is_default);
    await user.save();
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add home to user' });
  }
});

// Remove home from user
router.delete('/:id/remove-home/:homeId', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
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
router.post('/:id/set-default-home', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const { home_id } = req.body;
    
    if (!home_id) {
      return res.status(400).json({ error: 'Home ID is required' });
    }
    
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
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
    if (req.user.role !== 'admin' && !getUserHomeIds(req.user).includes(req.params.homeId)) {
      return res.status(403).json({ error: 'Access denied. You can only view staff in your own home.' });
    }
    const users = await User.find({ 'homes.home_id': req.params.homeId });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users by home' });
  }
});

module.exports = router;
