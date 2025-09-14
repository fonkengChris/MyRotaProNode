const express = require('express');
const router = express.Router();
const Timetable = require('../models/Timetable');
const Shift = require('../models/Shift');
const User = require('../models/User');
const { requireRole } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const SchedulingConflictService = require('../services/schedulingConflictService');

// Get all timetables accessible to the user
router.get('/', async (req, res) => {
  try {
    const { status, home_id, start_date, end_date, user_access } = req.query;
    const user = req.user;
    
    // Build base query
    let query = {};
    
    // Filter by status
    if (status) {
      query.status = status;
    }
    
    // Filter by home
    if (home_id) {
      query.home_ids = home_id;
    }
    
    // Filter by date range
    if (start_date || end_date) {
      query.start_date = {};
      if (start_date) query.start_date.$gte = new Date(start_date);
      if (end_date) query.start_date.$lte = new Date(end_date);
    }
    
    // Get all timetables that match the query
    let timetables = await Timetable.find(query)
      .populate('home_ids', 'name location')
      .populate('service_id', 'name')
      .populate('generated_by', 'name email')
      .sort({ created_at: -1 });
    
    // Filter by user access permissions
    let accessibleTimetables;
    
    if (user_access === 'true') {
      // For user access, show timetables where user has assignments OR meets access criteria
      accessibleTimetables = timetables.filter(timetable => {
        // First check if user has assignments in any of the weekly rotas
        const hasAssignments = timetable.weekly_rotas.some(week => 
          week.shifts.some(shift => 
            shift.assigned_staff.some(staff => 
              staff.user_id.toString() === user._id.toString()
            )
          )
        );
        
        // If user has assignments, they can access the timetable
        if (hasAssignments) {
          return true;
        }
        
        // Otherwise, check normal access permissions
        return timetable.canUserAccess(user);
      });
    } else {
      // Normal access control for admin view
      accessibleTimetables = timetables.filter(timetable => 
        timetable.canUserAccess(user)
      );
    }
    
    res.json(accessibleTimetables);
  } catch (error) {
    console.error('Error fetching timetables:', error);
    res.status(500).json({ error: 'Failed to fetch timetables' });
  }
});

// Get timetable by ID
router.get('/:id', async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id)
      .populate('home_ids', 'name location')
      .populate('service_id', 'name')
      .populate('generated_by', 'name email')
      .populate('weekly_rotas.shifts.assigned_staff.user_id', 'name email role type');
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    // Check if user can access this timetable
    if (!timetable.canUserAccess(req.user)) {
      return res.status(403).json({ error: 'Access denied to this timetable' });
    }
    
    res.json(timetable);
  } catch (error) {
    console.error('Error fetching timetable:', error);
    res.status(500).json({ error: 'Failed to fetch timetable' });
  }
});

// Create new timetable (draft)
router.post('/', [
  requireRole(['admin', 'home_manager']),
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name is required and must be less than 100 characters'),
  body('description').optional().trim().isLength({ max: 500 }).withMessage('Description must be less than 500 characters'),
  body('home_ids').isArray({ min: 1 }).withMessage('At least one home must be selected'),
  body('service_id').isMongoId().withMessage('Valid service ID is required'),
  body('start_date').isISO8601().withMessage('Valid start date is required'),
  body('end_date').isISO8601().withMessage('Valid end date is required'),
  body('total_weeks').isInt({ min: 1, max: 52 }).withMessage('Total weeks must be between 1 and 52')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }
    
    const { name, description, home_ids, service_id, start_date, end_date, total_weeks } = req.body;
    
    // Validate date range
    const start = new Date(start_date);
    const end = new Date(end_date);
    
    if (start >= end) {
      return res.status(400).json({ error: 'End date must be after start date' });
    }
    
    // Calculate actual weeks
    const actualWeeks = Math.ceil((end - start) / (7 * 24 * 60 * 60 * 1000));
    if (actualWeeks !== total_weeks) {
      return res.status(400).json({ 
        error: `Date range spans ${actualWeeks} weeks, but ${total_weeks} weeks specified` 
      });
    }
    
    // Create timetable draft
    const timetable = new Timetable({
      name,
      description,
      home_ids,
      service_id,
      start_date: start,
      end_date: end,
      total_weeks,
      generated_by: req.user._id,
      status: 'draft',
      total_shifts: 0,
      total_hours: 0,
      total_assignments: 0,
      average_weekly_hours: 0,
      weekly_rotas: []
    });
    
    await timetable.save();
    
    res.status(201).json(timetable);
  } catch (error) {
    console.error('Error creating timetable:', error);
    res.status(400).json({ error: 'Failed to create timetable' });
  }
});

// Generate timetable from existing rotas
router.post('/:id/generate', [
  requireRole(['admin', 'home_manager'])
], async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id);
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    if (timetable.status !== 'draft') {
      return res.status(400).json({ error: 'Can only generate draft timetables' });
    }
    
    // Check if user can modify this timetable
    if (timetable.generated_by.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied to modify this timetable' });
    }
    
    // Update status to generating
    timetable.status = 'generating';
    timetable.generation_started_at = new Date();
    await timetable.save();
    
    // Start generation process asynchronously
    generateTimetableAsync(timetable._id, req.user._id);
    
    res.json({ 
      message: 'Timetable generation started', 
      timetable_id: timetable._id,
      status: 'generating'
    });
  } catch (error) {
    console.error('Error starting timetable generation:', error);
    res.status(500).json({ error: 'Failed to start timetable generation' });
  }
});

// Check timetable generation status
router.get('/:id/status', async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id).select('status generation_started_at generation_completed_at generation_duration_ms conflicts_detected generation_errors generated_by is_public accessible_by_roles accessible_by_users');
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    // Check if user can access this timetable
    if (!timetable.canUserAccess(req.user)) {
      return res.status(403).json({ error: 'Access denied to this timetable' });
    }
    
    res.json({
      status: timetable.status,
      generation_started_at: timetable.generation_started_at,
      generation_completed_at: timetable.generation_completed_at,
      generation_duration_ms: timetable.generation_duration_ms,
      conflicts_detected: timetable.conflicts_detected,
      generation_errors: timetable.generation_errors
    });
  } catch (error) {
    console.error('Error checking timetable status:', error);
    res.status(500).json({ error: 'Failed to check timetable status' });
  }
});

// Update timetable (only draft status)
router.put('/:id', [
  requireRole(['admin', 'home_manager'])
], async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id);
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    if (timetable.status !== 'draft') {
      return res.status(400).json({ error: 'Can only update draft timetables' });
    }
    
    // Check if user can modify this timetable
    if (timetable.generated_by.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied to modify this timetable' });
    }
    
    // Only allow updating certain fields
    const allowedUpdates = ['name', 'description', 'is_public', 'accessible_by_roles', 'accessible_by_users'];
    const updates = {};
    
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });
    
    const updatedTimetable = await Timetable.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );
    
    res.json(updatedTimetable);
  } catch (error) {
    console.error('Error updating timetable:', error);
    res.status(400).json({ error: 'Failed to update timetable' });
  }
});

// Publish timetable
router.post('/:id/publish', [
  requireRole(['admin', 'home_manager'])
], async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id);
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    // Check if user can modify this timetable
    if (timetable.generated_by.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied to modify this timetable' });
    }
    
    if (timetable.status !== 'generated') {
      return res.status(400).json({ error: 'Can only publish generated timetables' });
    }
    
    if (timetable.conflicts_detected > 0) {
      return res.status(400).json({ error: 'Cannot publish timetable with conflicts' });
    }
    
    await timetable.publish();
    await timetable.save();
    
    res.json(timetable);
  } catch (error) {
    console.error('Error publishing timetable:', error);
    res.status(400).json({ error: 'Failed to publish timetable' });
  }
});

// Archive timetable
router.post('/:id/archive', [
  requireRole(['admin', 'home_manager'])
], async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id);
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    // Check if user can modify this timetable
    if (timetable.generated_by.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied to modify this timetable' });
    }
    
    await timetable.archive();
    await timetable.save();
    
    res.json(timetable);
  } catch (error) {
    console.error('Error archiving timetable:', error);
    res.status(400).json({ error: 'Failed to archive timetable' });
  }
});

// Delete timetable (only draft status)
router.delete('/:id', [
  requireRole(['admin', 'home_manager'])
], async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id);
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    if (timetable.status !== 'draft') {
      return res.status(400).json({ error: 'Can only delete draft timetables' });
    }
    
    // Check if user can modify this timetable
    if (timetable.generated_by.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied to modify this timetable' });
    }
    
    await Timetable.findByIdAndDelete(req.params.id);
    res.json({ message: 'Timetable deleted successfully' });
  } catch (error) {
    console.error('Error deleting timetable:', error);
    res.status(500).json({ error: 'Failed to delete timetable' });
  }
});

// Get timetable summary for dashboard
router.get('/:id/summary', async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id);
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    // Check if user can access this timetable
    if (!timetable.canUserAccess(req.user)) {
      return res.status(403).json({ error: 'Access denied to this timetable' });
    }
    
    res.json(timetable.getSummary());
  } catch (error) {
    console.error('Error fetching timetable summary:', error);
    res.status(500).json({ error: 'Failed to fetch timetable summary' });
  }
});

// Get weekly breakdown for timetable
router.get('/:id/weekly-breakdown', async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id);
    
    if (!timetable) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    
    // Check if user can access this timetable
    if (!timetable.canUserAccess(req.user)) {
      return res.status(403).json({ error: 'Access denied to this timetable' });
    }
    
    res.json(timetable.getWeeklyBreakdown());
  } catch (error) {
    console.error('Error fetching weekly breakdown:', error);
    res.status(500).json({ error: 'Failed to fetch weekly breakdown' });
  }
});

// Async function to generate timetable
async function generateTimetableAsync(timetableId, userId) {
  try {
    const timetable = await Timetable.findById(timetableId);
    if (!timetable) {
      throw new Error('Timetable not found');
    }
    
    console.log(`Starting timetable generation for ${timetable.name}...`);
    
    // Import AI Solver
    const AISolver = require('../services/aiSolver');
    const aiSolver = new AISolver();
    
    let totalShifts = 0;
    let totalHours = 0;
    let totalAssignments = 0;
    let totalConflicts = 0;
    const weeklyRotas = [];
    const generationErrors = [];
    
    // Generate rota for each week
    for (let week = 0; week < timetable.total_weeks; week++) {
      try {
        const weekStart = new Date(timetable.start_date);
        weekStart.setDate(weekStart.getDate() + (week * 7));
        
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        
        console.log(`Generating week ${week + 1}/${timetable.total_weeks}: ${weekStart.toISOString().split('T')[0]} to ${weekEnd.toISOString().split('T')[0]}`);
        
        // Generate rota for this week using AI Solver
        const result = await aiSolver.generateRota(
          weekStart,
          weekEnd,
          timetable.home_ids,
          timetable.service_id,
          [] // Don't pass existing shifts for timetable generation
        );
        
        if (!result.success) {
          throw new Error(result.error || 'AI generation failed');
        }
        
        // Get shifts for this week
        const weekShifts = await Shift.find({
          home_id: { $in: timetable.home_ids },
          date: {
            $gte: weekStart.toISOString().split('T')[0],
            $lte: weekEnd.toISOString().split('T')[0]
          }
        }).populate('assigned_staff.user_id', 'name role type');
        
        // Check for conflicts in this week
        let weekConflicts = 0;
        for (const homeId of timetable.home_ids) {
          try {
            const conflicts = await SchedulingConflictService.getHomeConflicts(
              homeId,
              weekStart.toISOString().split('T')[0],
              weekEnd.toISOString().split('T')[0]
            );
            weekConflicts += conflicts.totalConflicts;
          } catch (error) {
            console.warn(`Failed to check conflicts for home ${homeId}:`, error.message);
          }
        }
        
        totalConflicts += weekConflicts;
        
        // Calculate week statistics
        const weekTotalShifts = weekShifts.length;
        const weekTotalHours = weekShifts.reduce((sum, shift) => sum + (shift.duration_hours || 0), 0);
        const weekTotalAssignments = weekShifts.reduce((sum, shift) => sum + (shift.assigned_staff?.length || 0), 0);
        
        // Calculate employment distribution for this week
        const employmentDistribution = calculateEmploymentDistribution(weekShifts);
        
        // Create weekly rota snapshot
        const weeklyRota = {
          week_start_date: weekStart,
          week_end_date: weekEnd,
          week_number: week + 1,
          shifts: weekShifts.map(shift => ({
            shift_id: shift._id,
            home_id: shift.home_id,
            service_id: shift.service_id,
            date: shift.date,
            start_time: shift.start_time,
            end_time: shift.end_time,
            shift_type: shift.shift_type,
            required_staff_count: shift.required_staff_count,
            assigned_staff: shift.assigned_staff.map(assignment => ({
              user_id: assignment.user_id._id,
              name: assignment.user_id.name,
              role: assignment.user_id.role,
              type: assignment.user_id.type,
              status: assignment.status,
              assigned_at: assignment.assigned_at
            })),
            notes: shift.notes,
            duration_hours: shift.duration_hours || 0
          })),
          total_shifts: weekTotalShifts,
          total_hours: weekTotalHours,
          total_assignments: weekTotalAssignments,
          employment_distribution: employmentDistribution
        };
        
        weeklyRotas.push(weeklyRota);
        
        totalShifts += weekTotalShifts;
        totalHours += weekTotalHours;
        totalAssignments += weekTotalAssignments;
        
        console.log(`Week ${week + 1} completed: ${weekTotalShifts} shifts, ${weekTotalHours} hours, ${weekTotalAssignments} assignments, ${weekConflicts} conflicts`);
        
      } catch (error) {
        console.error(`Error generating week ${week + 1}:`, error);
        generationErrors.push({
          week: week + 1,
          error: error.message,
          timestamp: new Date()
        });
        
        // Continue with next week even if this one fails
      }
    }
    
    // Update timetable with results
    const generationCompletedAt = new Date();
    const generationDuration = generationCompletedAt - timetable.generation_started_at;
    
    timetable.weekly_rotas = weeklyRotas;
    timetable.total_shifts = totalShifts;
    timetable.total_hours = totalHours;
    timetable.total_assignments = totalAssignments;
    timetable.average_weekly_hours = timetable.total_weeks > 0 ? totalHours / timetable.total_weeks : 0;
    timetable.conflicts_detected = totalConflicts;
    timetable.generation_errors = generationErrors;
    timetable.generation_completed_at = generationCompletedAt;
    timetable.generation_duration_ms = generationDuration;
    
    // Set status based on results
    if (generationErrors.length === 0 && totalConflicts === 0) {
      timetable.status = 'generated';
    } else {
      timetable.status = 'draft'; // Keep as draft if there are errors or conflicts
    }
    
    await timetable.save();
    
    console.log(`Timetable generation completed for ${timetable.name}: ${totalShifts} shifts, ${totalHours} hours, ${totalAssignments} assignments, ${totalConflicts} conflicts, ${generationErrors.length} errors`);
    
  } catch (error) {
    console.error('Timetable generation failed:', error);
    
    // Update timetable with error status
    try {
      const timetable = await Timetable.findById(timetableId);
      if (timetable) {
        timetable.status = 'draft';
        timetable.generation_errors.push({
          week: 0,
          error: error.message,
          timestamp: new Date()
        });
        await timetable.save();
      }
    } catch (updateError) {
      console.error('Failed to update timetable with error:', updateError);
    }
  }
}

// Helper function to calculate employment distribution
function calculateEmploymentDistribution(shifts) {
  const distribution = {
    fulltime: { total_hours: 0, staff_count: 0, average_hours: 0 },
    parttime: { total_hours: 0, staff_count: 0, average_hours: 0 },
    bank: { total_hours: 0, staff_count: 0, average_hours: 0 }
  };
  
  const staffHours = {};
  
  shifts.forEach(shift => {
    if (shift.assigned_staff && shift.assigned_staff.length > 0) {
      shift.assigned_staff.forEach(assignment => {
        const staffId = assignment.user_id._id.toString();
        const staffType = assignment.user_id.type;
        const hours = shift.duration_hours || 0;
        
        if (!staffHours[staffId]) {
          staffHours[staffId] = { type: staffType, hours: 0 };
        }
        staffHours[staffId].hours += hours;
      });
    }
  });
  
  // Calculate totals by type
  Object.values(staffHours).forEach(staff => {
    if (distribution[staff.type]) {
      distribution[staff.type].total_hours += staff.hours;
      distribution[staff.type].staff_count++;
    }
  });
  
  // Calculate averages
  Object.keys(distribution).forEach(type => {
    if (distribution[type].staff_count > 0) {
      distribution[type].average_hours = distribution[type].total_hours / distribution[type].staff_count;
    }
  });
  
  return distribution;
}

module.exports = router;
