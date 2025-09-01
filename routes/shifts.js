const express = require('express');
const router = express.Router();
const Shift = require('../models/Shift');
const { requireRole } = require('../middleware/auth');

// Get all shifts
router.get('/', async (req, res) => {
  try {
    const { home_id, service_id, date, start_date, end_date, user_id } = req.query;
    const filter = {};
    
    // Validate home_id if provided
    if (home_id && home_id !== 'undefined' && home_id !== 'null') {
      filter.home_id = home_id;
    }
    if (service_id && service_id !== 'undefined' && service_id !== 'null') {
      filter.service_id = service_id;
    }
    if (date) filter.date = date;
    if (start_date || end_date) {
      filter.date = {};
      if (start_date) filter.date.$gte = start_date;
      if (end_date) filter.date.$lte = end_date;
    }
    
    // If user_id is provided, filter by assigned staff
    if (user_id && user_id !== 'undefined' && user_id !== 'null') {
      filter['assigned_staff.user_id'] = user_id;
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
    await shift.save();
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

    // Check for scheduling conflicts before assigning staff
    const SchedulingConflictService = require('../services/schedulingConflictService');
    const conflictCheck = await SchedulingConflictService.checkShiftAssignmentConflict(
      user_id,
      shift.date,
      shift.start_time,
      shift.end_time
    );

    if (conflictCheck.hasConflict) {
      let userFriendlyMessage = '';
      
      switch (conflictCheck.conflictType) {
        case 'time_off':
          userFriendlyMessage = `Cannot assign staff member to shift on ${conflictCheck.conflicts[0]?.start_date || 'this date'} - they have approved time off`;
          break;
        case 'overlapping_shift':
          userFriendlyMessage = `Cannot assign staff member - they already have overlapping shifts on ${conflictCheck.conflicts[0]?.date || 'this date'}`;
          break;
        case 'max_hours_exceeded':
          userFriendlyMessage = `Cannot assign staff member - this would exceed maximum daily hours (${conflictCheck.message})`;
          break;
        default:
          userFriendlyMessage = conflictCheck.message;
      }
      
      return res.status(409).json({
        error: 'Scheduling conflict detected',
        conflict: conflictCheck,
        message: userFriendlyMessage,
        userFriendlyMessage: userFriendlyMessage
      });
    }
    
    // Check if shift is already fully staffed
    if (shift.assigned_staff.length >= shift.required_staff_count) {
      return res.status(400).json({ 
        error: 'Shift is already fully staffed',
        message: `This shift requires ${shift.required_staff_count} staff members and already has ${shift.assigned_staff.length} assigned`
      });
    }

    // Check if staff member is already assigned to this shift
    const isAlreadyAssigned = shift.assigned_staff.some(assignment => 
      assignment.user_id.toString() === user_id
    );
    
    if (isAlreadyAssigned) {
      return res.status(400).json({ 
        error: 'Staff member already assigned',
        message: 'This staff member is already assigned to this shift'
      });
    }

    shift.assignStaff(user_id, note);
    await shift.save();
    
    res.json(shift);
  } catch (error) {
    console.error('Error assigning staff to shift:', error);
    
    if (error.name === 'ValidationError') {
      res.status(400).json({ 
        error: 'Validation failed', 
        details: Object.values(error.errors).map(err => err.message)
      });
    } else if (error.name === 'CastError') {
      res.status(400).json({ 
        error: 'Invalid data format', 
        details: error.message 
      });
    } else {
      res.status(500).json({ 
        error: 'Internal server error',
        message: 'An unexpected error occurred while assigning staff'
      });
    }
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

// Check for scheduling conflicts
router.get('/conflicts/check', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const { home_id, start_date, end_date } = req.query;
    
    if (!home_id || !start_date || !end_date) {
      return res.status(400).json({ 
        error: 'Missing required parameters: home_id, start_date, end_date' 
      });
    }

    const SchedulingConflictService = require('../services/schedulingConflictService');
    const conflicts = await SchedulingConflictService.getHomeConflicts(home_id, start_date, end_date);
    
    res.json(conflicts);
  } catch (error) {
    console.error('Error checking scheduling conflicts:', error);
    res.status(500).json({ error: 'Failed to check scheduling conflicts' });
  }
});

module.exports = router;
