const express = require('express');
const router = express.Router();
const Home = require('../models/Home');
const { authenticateToken, requireRole } = require('../middleware/auth');

// Get all homes
router.get('/', authenticateToken, async (req, res) => {
  try {
    const homes = await Home.find().populate('manager_id', 'name email');
    res.json(homes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch homes' });
  }
});

// Get home by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const home = await Home.findById(req.params.id).populate('manager_id', 'name email');
    if (!home) {
      return res.status(404).json({ error: 'Home not found' });
    }
    res.json(home);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch home' });
  }
});

// Create new home
router.post('/', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const home = new Home(req.body);
    await home.save();
    
    // Populate the manager details before sending response
    const populatedHome = await Home.findById(home._id).populate('manager_id', 'name email');
    
    res.status(201).json(populatedHome);
  } catch (error) {

    res.status(400).json({ error: 'Failed to create home' });
  }
});

// Update home
router.put('/:id', authenticateToken, requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const home = await Home.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!home) {
      return res.status(404).json({ error: 'Home not found' });
    }
    
    // Populate the manager details before sending response
    const populatedHome = await Home.findById(home._id).populate('manager_id', 'name email');
    
    res.json(populatedHome);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update home' });
  }
});

// Delete home
router.delete('/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const home = await Home.findByIdAndDelete(req.params.id);
    if (!home) {
      return res.status(404).json({ error: 'Home not found' });
    }
    res.json({ message: 'Home deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete home' });
  }
});

module.exports = router;
