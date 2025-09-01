const express = require('express');
const router = express.Router();
const Availability = require('../models/Availability');
const { requireRole, requireOwnershipOrPermission } = require('../middleware/auth');

// Get all availability records
router.get('/', async (req, res) => {
  try {
    const { user_id, date, start_date, end_date } = req.query;
    const filter = {};
    
    if (user_id) filter.user_id = user_id;
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
    if (!availability) {
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

    
    // Check if there's already an availability record for this user and date
    const existingAvailability = await Availability.findOne({
      user_id: req.body.user_id,
      date: req.body.date
    });
    
    if (existingAvailability) {
      
      
      // Update the existing record with the new data
      const updatedAvailability = await Availability.findByIdAndUpdate(
        existingAvailability._id,
        req.body,
        { new: true, runValidators: true }
      );
      
      
      res.json(updatedAvailability);
    } else {
      // Create new availability record
      const availability = new Availability(req.body);
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
router.put('/:id', requireOwnershipOrPermission, async (req, res) => {
  try {
    const availability = await Availability.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!availability) {
      return res.status(404).json({ error: 'Availability record not found' });
    }
    
    res.json(availability);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update availability record' });
  }
});

// Delete availability
router.delete('/:id', requireOwnershipOrPermission, async (req, res) => {
  try {
    const availability = await Availability.findByIdAndDelete(req.params.id);
    if (!availability) {
      return res.status(404).json({ error: 'Availability record not found' });
    }
    res.json({ message: 'Availability record deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete availability record' });
  }
});

// Get user availability for a date range
router.get('/user/:userId', async (req, res) => {
  try {
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
