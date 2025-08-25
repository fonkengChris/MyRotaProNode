const express = require('express');
const router = express.Router();
const Shift = require('../models/Shift');
const { requireRole } = require('../middleware/auth');

// Get all shifts
router.get('/', async (req, res) => {
  try {
    const { home_id, service_id, date, start_date, end_date } = req.query;
    const filter = {};
    
    if (home_id) filter.home_id = home_id;
    if (service_id) filter.service_id = service_id;
    if (date) filter.date = date;
    if (start_date || end_date) {
      filter.date = {};
      if (start_date) filter.date.$gte = start_date;
      if (end_date) filter.date.$lte = end_date;
    }
    
    const shifts = await Shift.find(filter).populate('service_id', 'name');
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// Get shift by ID
router.get('/:id', async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id).populate('service_id', 'name');
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.json(shift);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch shift' });
  }
});

// Create new shift
router.post('/', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    console.log('🔄 Creating shift with data:', req.body);
    console.log('📅 Raw date from request:', req.body.date);
    console.log('📅 Date type:', typeof req.body.date);
    
    // Validate that the service exists
    const Service = require('../models/Service');
    const service = await Service.findById(req.body.service_id);
    if (!service) {
      return res.status(400).json({ 
        error: 'Service not found', 
        details: ['The specified service does not exist'] 
      });
    }
    
    // Check for shift overlaps (handles multi-day shifts)
    const { home_id, date, start_time, end_time } = req.body;
    
    // Check for overlaps on the same date
    const sameDateShifts = await Shift.find({ 
      home_id, 
      date,
      _id: { $ne: req.body.id } // Exclude current shift if updating
    });
    
    // Check for overlaps on the next day (for overnight shifts)
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().split('T')[0];
    
    const nextDayShifts = await Shift.find({ 
      home_id, 
      date: nextDayStr,
      _id: { $ne: req.body.id } // Exclude current shift if updating
    });
    
    const allRelevantShifts = [...sameDateShifts, ...nextDayShifts];
    
    const hasOverlap = allRelevantShifts.some(existingShift => {
      const existingStart = new Date(`2000-01-01T${existingShift.start_time}`);
      let existingEnd = new Date(`2000-01-01T${existingShift.end_time}`);
      const newStart = new Date(`2000-01-01T${start_time}`);
      let newEnd = new Date(`2000-01-01T${end_time}`);
      
      // Handle overnight shifts
      if (existingEnd < existingStart) existingEnd.setDate(existingEnd.getDate() + 1);
      if (newEnd < newStart) newEnd.setDate(newEnd.getDate() + 1);
      
      // Convert all times to minutes since midnight for easier comparison
      const newStartMinutes = newStart.getHours() * 60 + newStart.getMinutes();
      const newEndMinutes = newEnd.getHours() * 60 + newEnd.getMinutes();
      const existingStartMinutes = existingStart.getHours() * 60 + existingStart.getMinutes();
      const existingEndMinutes = existingEnd.getHours() * 60 + existingEnd.getMinutes();
      
      // Check for overlap
      return !(newEndMinutes <= existingStartMinutes || newStartMinutes >= existingEndMinutes);
    });
    
    if (hasOverlap) {
      return res.status(400).json({
        error: 'Shift overlap detected',
        details: ['This shift overlaps with an existing shift at the same home']
      });
    }
    
    const shift = new Shift(req.body);
    console.log('📅 Processed date in shift object:', shift.date);
    console.log('📅 Date type:', typeof shift.date);
    console.log('📅 Date value:', shift.date);
    
    await shift.save();
    
    console.log('✅ Shift created successfully:', shift._id);
    res.status(201).json(shift);
  } catch (error) {
    console.error('❌ Error creating shift:', error);
    
    // Provide more detailed error messages
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    } else if (error.name === 'CastError') {
      res.status(400).json({ 
        error: 'Invalid data format', 
        details: error.message 
      });
    } else {
      res.status(400).json({ error: 'Failed to create shift' });
    }
  }
});

// Update shift
router.put('/:id', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    // Check for shift overlaps (excluding current shift, handles multi-day shifts)
    const { home_id, date, start_time, end_time } = req.body;
    
    // Check for overlaps on the same date
    const sameDateShifts = await Shift.find({ 
      home_id, 
      date,
      _id: { $ne: req.params.id } // Exclude current shift being updated
    });
    
    // Check for overlaps on the next day (for overnight shifts)
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().split('T')[0];
    
    const nextDayShifts = await Shift.find({ 
      home_id, 
      date: nextDayStr,
      _id: { $ne: req.params.id } // Exclude current shift being updated
    });
    
    const allRelevantShifts = [...sameDateShifts, ...nextDayShifts];
    
    const hasOverlap = allRelevantShifts.some(existingShift => {
      const existingStart = new Date(`2000-01-01T${existingShift.start_time}`);
      let existingEnd = new Date(`2000-01-01T${existingShift.end_time}`);
      const newStart = new Date(`2000-01-01T${start_time}`);
      let newEnd = new Date(`2000-01-01T${end_time}`);
      
      // Handle overnight shifts
      if (existingEnd < existingStart) existingEnd.setDate(existingEnd.getDate() + 1);
      if (newEnd < newStart) newEnd.setDate(newEnd.getDate() + 1);
      
      // Convert all times to minutes since midnight for easier comparison
      const newStartMinutes = newStart.getHours() * 60 + newStart.getMinutes();
      const newEndMinutes = newEnd.getHours() * 60 + newEnd.getMinutes();
      const existingStartMinutes = existingStart.getHours() * 60 + existingStart.getMinutes();
      const existingEndMinutes = existingEnd.getHours() * 60 + existingEnd.getMinutes();
      
      // Check for overlap
      return !(newEndMinutes <= existingStartMinutes || newStartMinutes >= existingEndMinutes);
    });
    
    if (hasOverlap) {
      return res.status(400).json({
        error: 'Shift overlap detected',
        details: ['This shift overlaps with an existing shift at the same home']
      });
    }
    
    const shift = await Shift.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    res.json(shift);
  } catch (error) {
    console.error('❌ Error updating shift:', error);
    
    // Provide more detailed error messages
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    } else if (error.name === 'CastError') {
      res.status(400).json({ 
        error: 'Invalid data format', 
        details: error.message 
      });
    } else {
      res.status(400).json({ error: 'Failed to update shift' });
    }
  }
});

// Delete shift
router.delete('/:id', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const shift = await Shift.findByIdAndDelete(req.params.id);
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.json({ message: 'Shift deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

// Assign staff to shift
router.post('/:id/assign', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const { user_id, note } = req.body;
    const shift = await Shift.findById(req.params.id);
    
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    shift.assignStaff(user_id, note);
    await shift.save();
    
    res.json(shift);
  } catch (error) {
    res.status(400).json({ error: 'Failed to assign staff' });
  }
});

// Remove staff from shift
router.delete('/:id/assign/:userId', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    shift.removeStaff(req.params.userId);
    await shift.save();
    
    res.json(shift);
  } catch (error) {
    res.status(400).json({ error: 'Failed to remove staff' });
  }
});

module.exports = router;
