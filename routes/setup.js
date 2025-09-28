const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Home = require('../models/Home');
const bcrypt = require('bcryptjs');

// @route   POST /api/setup/initial
// @desc    Initial setup - create first admin user and home
// @access  Public (only works if no users exist)
router.post('/initial', async (req, res) => {
  try {
    // Check if any users already exist
    const existingUsers = await User.countDocuments();
    if (existingUsers > 0) {
      return res.status(403).json({ 
        error: 'Setup already completed. Users exist in the system.' 
      });
    }

    const { 
      adminUser: { name, email, phone, password },
      home: { name: homeName, location, contact_info, capacity, operating_hours }
    } = req.body;

    // Validate required fields
    if (!name || !email || !phone || !password || !homeName || !location || !contact_info) {
      return res.status(400).json({ 
        error: 'All fields are required for initial setup' 
      });
    }

    // Create the home first (bypass validation for initial setup)
    const home = new Home({
      name: homeName,
      location,
      contact_info,
      capacity: capacity || 10,
      operating_hours: operating_hours || { start: '08:00', end: '18:00' },
      manager_id: null, // Will be set after user creation
      is_active: true
    });

    await home.save({ validateBeforeSave: false });

    // Create the admin user
    const hashedPassword = await bcrypt.hash(password, 12);
    const adminUser = new User({
      name,
      email,
      phone,
      password: hashedPassword,
      role: 'admin',
      home_id: home._id,
      is_active: true
    });

    await adminUser.save();

    // Update the home with the manager_id
    home.manager_id = adminUser._id;
    await home.save();

    res.status(201).json({
      message: 'Initial setup completed successfully',
      adminUser: {
        id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role
      },
      home: {
        id: home._id,
        name: home.name,
        location: home.location
      }
    });

  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ 
      error: 'Server error during setup',
      details: error.message 
    });
  }
});

// @route   GET /api/setup/status
// @desc    Check if initial setup is needed
// @access  Public
router.get('/status', async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const homeCount = await Home.countDocuments();
    
    res.json({
      setupNeeded: userCount === 0,
      userCount,
      homeCount
    });
  } catch (error) {
    console.error('Setup status check error:', error);
    res.status(500).json({ 
      error: 'Server error during status check' 
    });
  }
});

module.exports = router;
