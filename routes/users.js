const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { requireRole, requireHomeAccess } = require('../middleware/auth');

// Get all users (filtered by home for non-admins)
router.get('/', async (req, res) => {
  try {
    const { home_id, role, is_active } = req.query;
    const filter = {};
    
    if (home_id) filter.home_id = home_id;
    if (role) filter.role = role;
    if (is_active !== undefined) filter.is_active = is_active === 'true';
    
    const users = await User.find(filter).select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
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
    ).select('-password');
    
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
    ).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// Allocate home to user
router.post('/:id/allocate-home', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const { home_id } = req.body;
    
    if (!home_id) {
      return res.status(400).json({ error: 'Home ID is required' });
    }
    
    // Check if home exists
    const Home = require('../models/Home');
    const home = await Home.findById(home_id);
    if (!home) {
      return res.status(404).json({ error: 'Home not found' });
    }
    
    // Update user with home_id
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { home_id },
      { new: true, runValidators: true }
    ).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to allocate home to user' });
  }
});

// Remove home allocation from user
router.delete('/:id/allocate-home', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { home_id: null },
      { new: true, runValidators: true }
    ).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove home allocation from user' });
  }
});

module.exports = router;
