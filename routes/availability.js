const express = require('express');
const router = express.Router();
const Availability = require('../models/Availability');

// Admins manage anyone's availability; part-time/bank staff manage only their own.
const canManageAvailabilityFor = (actor, targetUserId) =>
  actor.role === 'admin' ||
  (String(targetUserId) === actor._id.toString() && ['parttime', 'bank'].includes(actor.type));

const forbidden = (res, actor) => res.status(403).json({
  error: actor.type === 'fulltime' && actor.role !== 'admin'
    ? 'Your availability is managed by an admin'
    : 'You can only manage your own availability',
  code: 'AVAILABILITY_FORBIDDEN'
});

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
    if (!canManageAvailabilityFor(req.user, req.body.user_id)) {
      return forbidden(res, req.user);
    }

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
router.put('/:id', async (req, res) => {
  try {
    const existing = await Availability.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Availability record not found' });
    }
    if (!canManageAvailabilityFor(req.user, existing.user_id)) {
      return forbidden(res, req.user);
    }

    // A record can't be reassigned to another staff member.
    const { user_id, ...updates } = req.body;
    const availability = await Availability.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    res.json(availability);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update availability record' });
  }
});

// Delete availability
router.delete('/:id', async (req, res) => {
  try {
    const availability = await Availability.findById(req.params.id);
    if (!availability) {
      return res.status(404).json({ error: 'Availability record not found' });
    }
    if (!canManageAvailabilityFor(req.user, availability.user_id)) {
      return forbidden(res, req.user);
    }
    await availability.deleteOne();
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
