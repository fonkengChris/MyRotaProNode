const express = require('express');
const router = express.Router();
const WeeklySchedule = require('../models/WeeklySchedule');
const { requireRole } = require('../middleware/auth');

// Get weekly schedule by home ID
router.get('/home/:homeId', async (req, res) => {
  try {
    const schedule = await WeeklySchedule.findOne({ 
      home_id: req.params.homeId,
      is_active: true 
    }).populate('schedule.monday.shifts.service_id', 'name category')
      .populate('schedule.tuesday.shifts.service_id', 'name category')
      .populate('schedule.wednesday.shifts.service_id', 'name category')
      .populate('schedule.thursday.shifts.service_id', 'name category')
      .populate('schedule.friday.shifts.service_id', 'name category')
      .populate('schedule.saturday.shifts.service_id', 'name category')
      .populate('schedule.sunday.shifts.service_id', 'name category');

    if (!schedule) {
      return res.status(404).json({ error: 'Weekly schedule not found for this home' });
    }

    res.json(schedule);
  } catch (error) {
    console.error('❌ Error fetching weekly schedule:', error);
    res.status(500).json({ error: 'Failed to fetch weekly schedule' });
  }
});

// Get all weekly schedules (admin only)
router.get('/', requireRole(['admin']), async (req, res) => {
  try {
    const schedules = await WeeklySchedule.find({ is_active: true })
      .populate('home_id', 'name location.city')
      .populate('schedule.monday.shifts.service_id', 'name category')
      .populate('schedule.tuesday.shifts.service_id', 'name category')
      .populate('schedule.wednesday.shifts.service_id', 'name category')
      .populate('schedule.thursday.shifts.service_id', 'name category')
      .populate('schedule.friday.shifts.service_id', 'name category')
      .populate('schedule.saturday.shifts.service_id', 'name category')
      .populate('schedule.sunday.shifts.service_id', 'name category');

    res.json(schedules);
  } catch (error) {
    console.error('❌ Error fetching weekly schedules:', error);
    res.status(500).json({ error: 'Failed to fetch weekly schedules' });
  }
});

// Create new weekly schedule for a home
router.post('/', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {

    
    // Check if a schedule already exists for this home
    const existingSchedule = await WeeklySchedule.findOne({ home_id: req.body.home_id });
    if (existingSchedule) {
      return res.status(400).json({ 
        error: 'Weekly schedule already exists for this home',
        details: ['Each home can only have one weekly schedule. Use PUT to update existing schedule.']
      });
    }

    const schedule = new WeeklySchedule(req.body);
    await schedule.save();
    
    
    
    // Populate service details before sending response
    const populatedSchedule = await WeeklySchedule.findById(schedule._id)
      .populate('schedule.monday.shifts.service_id', 'name category')
      .populate('schedule.tuesday.shifts.service_id', 'name category')
      .populate('schedule.wednesday.shifts.service_id', 'name category')
      .populate('schedule.thursday.shifts.service_id', 'name category')
      .populate('schedule.friday.shifts.service_id', 'name category')
      .populate('schedule.saturday.shifts.service_id', 'name category')
      .populate('schedule.sunday.shifts.service_id', 'name category');
    
    res.status(201).json(populatedSchedule);
  } catch (error) {
    console.error('❌ Error creating weekly schedule:', error);
    
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    } else {
      res.status(400).json({ error: 'Failed to create weekly schedule' });
    }
  }
});

// Update existing weekly schedule
router.put('/:id', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {

    
    const schedule = await WeeklySchedule.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!schedule) {
      return res.status(404).json({ error: 'Weekly schedule not found' });
    }
    
    
    
    // Populate service details before sending response
    const populatedSchedule = await WeeklySchedule.findById(schedule._id)
      .populate('schedule.monday.shifts.service_id', 'name category')
      .populate('schedule.tuesday.shifts.service_id', 'name category')
      .populate('schedule.wednesday.shifts.service_id', 'name category')
      .populate('schedule.thursday.shifts.service_id', 'name category')
      .populate('schedule.friday.shifts.service_id', 'name category')
      .populate('schedule.saturday.shifts.service_id', 'name category')
      .populate('schedule.sunday.shifts.service_id', 'name category');
    
    res.json(populatedSchedule);
  } catch (error) {
    console.error('❌ Error updating weekly schedule:', error);
    
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    } else {
      res.status(400).json({ error: 'Failed to update weekly schedule' });
    }
  }
});

// Delete weekly schedule
router.delete('/:id', requireRole(['admin']), async (req, res) => {
  try {
    const schedule = await WeeklySchedule.findByIdAndDelete(req.params.id);
    if (!schedule) {
      return res.status(404).json({ error: 'Weekly schedule not found' });
    }
    
    res.json({ message: 'Weekly schedule deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting weekly schedule:', error);
    res.status(500).json({ error: 'Failed to delete weekly schedule' });
  }
});

// Add shift to a specific day
router.post('/:id/days/:dayName/shifts', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const { id, dayName } = req.params;
    const shiftData = req.body;
    

    
    const schedule = await WeeklySchedule.findById(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Weekly schedule not found' });
    }
    
    schedule.addShiftToDay(dayName, shiftData);
    await schedule.save();
    
    
    
    // Populate service details before sending response
    const populatedSchedule = await WeeklySchedule.findById(schedule._id)
      .populate('schedule.monday.shifts.service_id', 'name category')
      .populate('schedule.tuesday.shifts.service_id', 'name category')
      .populate('schedule.wednesday.shifts.service_id', 'name category')
      .populate('schedule.thursday.shifts.service_id', 'name category')
      .populate('schedule.friday.shifts.service_id', 'name category')
      .populate('schedule.saturday.shifts.service_id', 'name category')
      .populate('schedule.sunday.shifts.service_id', 'name category');
    
    res.json(populatedSchedule);
  } catch (error) {
    console.error('❌ Error adding shift:', error);
    
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    } else {
      res.status(400).json({ error: 'Failed to add shift' });
    }
  }
});

// Remove shift from a specific day
router.delete('/:id/days/:dayName/shifts/:shiftIndex', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const { id, dayName, shiftIndex } = req.params;
    

    
    const schedule = await WeeklySchedule.findById(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Weekly schedule not found' });
    }
    
    schedule.removeShiftFromDay(dayName, parseInt(shiftIndex));
    await schedule.save();
    
    
    
    // Populate service details before sending response
    const populatedSchedule = await WeeklySchedule.findById(schedule._id)
      .populate('schedule.monday.shifts.service_id', 'name category')
      .populate('schedule.tuesday.shifts.service_id', 'name category')
      .populate('schedule.wednesday.shifts.service_id', 'name category')
      .populate('schedule.thursday.shifts.service_id', 'name category')
      .populate('schedule.friday.shifts.service_id', 'name category')
      .populate('schedule.saturday.shifts.service_id', 'name category')
      .populate('schedule.sunday.shifts.service_id', 'name category');
    
    res.json(populatedSchedule);
  } catch (error) {
    console.error('❌ Error removing shift:', error);
    res.status(500).json({ error: 'Failed to remove shift' });
  }
});

// Toggle day active/inactive status
router.patch('/:id/days/:dayName/toggle', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const { id, dayName } = req.params;
    

    
    const schedule = await WeeklySchedule.findById(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Weekly schedule not found' });
    }
    
    const day = dayName.toLowerCase();
    if (schedule.schedule[day]) {
      schedule.schedule[day].is_active = !schedule.schedule[day].is_active;
      await schedule.save();
      

      
      // Populate service details before sending response
      const populatedSchedule = await WeeklySchedule.findById(schedule._id)
        .populate('schedule.monday.shifts.service_id', 'name category')
        .populate('schedule.tuesday.shifts.service_id', 'name category')
        .populate('schedule.wednesday.shifts.service_id', 'name category')
        .populate('schedule.thursday.shifts.service_id', 'name category')
        .populate('schedule.friday.shifts.service_id', 'name category')
        .populate('schedule.saturday.shifts.service_id', 'name category')
        .populate('schedule.sunday.shifts.service_id', 'name category');
      
      res.json(populatedSchedule);
    } else {
      res.status(400).json({ error: 'Invalid day name' });
    }
  } catch (error) {
    console.error('❌ Error toggling day status:', error);
    res.status(500).json({ error: 'Failed to toggle day status' });
  }
});

module.exports = router;
