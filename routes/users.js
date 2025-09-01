const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { requireRole, requireHomeAccess } = require('../middleware/auth');

// Get all users (filtered by home for non-admins)
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
    
    const users = await User.find(filter);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user by ID
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
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user
router.put('/:id', async (req, res) => {
  try {
    const { password, ...updateData } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete user
router.delete('/:id', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
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
    const users = await User.find({ 'homes.home_id': req.params.homeId });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users by home' });
  }
});

module.exports = router;
