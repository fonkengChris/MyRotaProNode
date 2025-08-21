const express = require('express');
const router = express.Router();
const TimeOffRequest = require('../models/TimeOffRequest');
const { requireRole, requireOwnershipOrPermission } = require('../middleware/auth');

// Get all time-off requests
router.get('/', async (req, res) => {
  try {
    const { user_id, status, home_id, start_date, end_date } = req.query;
    const filter = {};
    
    if (user_id) filter.user_id = user_id;
    if (status) filter.status = status;
    if (home_id) filter.home_id = home_id;
    if (start_date || end_date) {
      filter.start_date = {};
      if (start_date) filter.start_date.$gte = start_date;
      if (end_date) filter.start_date.$lte = end_date;
    }
    
    const requests = await TimeOffRequest.find(filter)
      .populate('user_id', 'name email role')
      .populate('home_id', 'name');
    
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch time-off requests' });
  }
});

// Get time-off request by ID
router.get('/:id', async (req, res) => {
  try {
    const request = await TimeOffRequest.findById(req.params.id)
      .populate('user_id', 'name email role')
      .populate('home_id', 'name');
    
    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    
    res.json(request);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch time-off request' });
  }
});

// Create new time-off request
router.post('/', async (req, res) => {
  try {
    const request = new TimeOffRequest(req.body);
    await request.save();
    res.status(201).json(request);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create time-off request' });
  }
});

// Update time-off request
router.put('/:id', requireOwnershipOrPermission, async (req, res) => {
  try {
    const request = await TimeOffRequest.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    
    res.json(request);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update time-off request' });
  }
});

// Delete time-off request
router.delete('/:id', requireOwnershipOrPermission, async (req, res) => {
  try {
    const request = await TimeOffRequest.findByIdAndDelete(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    res.json({ message: 'Time-off request deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete time-off request' });
  }
});

// Approve time-off request
router.post('/:id/approve', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const request = await TimeOffRequest.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    
    await request.approve();
    res.json(request);
  } catch (error) {
    res.status(400).json({ error: 'Failed to approve time-off request' });
  }
});

// Deny time-off request
router.post('/:id/deny', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required for denial' });
    }
    
    const request = await TimeOffRequest.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    
    await request.deny(reason);
    res.json(request);
  } catch (error) {
    res.status(400).json({ error: 'Failed to deny time-off request' });
  }
});

// Get user time-off requests
router.get('/user/:userId', async (req, res) => {
  try {
    const { status, start_date, end_date } = req.query;
    const filter = { user_id: req.params.userId };
    
    if (status) filter.status = status;
    if (start_date || end_date) {
      filter.start_date = {};
      if (start_date) filter.start_date.$gte = start_date;
      if (end_date) filter.start_date.$lte = end_date;
    }
    
    const requests = await TimeOffRequest.find(filter).populate('home_id', 'name');
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user time-off requests' });
  }
});

module.exports = router;
