const express = require('express');
const router = express.Router();
const Home = require('../models/Home');
const { authenticateToken, requireRole, getUserHomeIds } = require('../middleware/auth');

// Get all homes (admins see all; everyone else only their own home(s))
router.get('/', authenticateToken, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role !== 'admin') {
      filter._id = { $in: getUserHomeIds(req.user) };
    }
    const homes = await Home.find(filter).populate('manager_id', 'name email');
    res.json(homes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch homes' });
  }
});

// Get home by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // Non-admins can only view a home they belong to.
    if (req.user.role !== 'admin' && !getUserHomeIds(req.user).includes(req.params.id)) {
      return res.status(403).json({ error: 'Access denied. You can only view your own home.' });
    }
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
    // manager_id is optional. When omitted/blank, don't persist an empty string
    // (it would fail ObjectId casting), so strip it out.
    if (!req.body.manager_id) {
      delete req.body.manager_id;
    }

    const home = new Home(req.body);
    await home.save();
    
    // Populate the manager details before sending response
    const populatedHome = await Home.findById(home._id).populate('manager_id', 'name email');
    
    res.status(201).json(populatedHome);
  } catch (error) {
    console.error('Home creation error:', error);
    res.status(400).json({ error: 'Failed to create home', details: error.message });
  }
});

// Update home
router.put('/:id', authenticateToken, requireRole(['admin', 'key_worker']), async (req, res) => {
  try {
    // A blank manager_id means "no manager"; store null rather than "" so the
    // ObjectId cast doesn't fail.
    if (req.body.manager_id === '') {
      req.body.manager_id = null;
    }

    // Break deduction policy directly affects payable hours, so only admins may
    // change it. Non-admin managers can edit other home fields, but any break_policy
    // they send is ignored (the stored value is left untouched).
    if (req.user.role !== 'admin') {
      delete req.body.break_policy;
    }

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
