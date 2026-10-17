const express = require('express');
const { body, validationResult } = require('express-validator');
const AISolver = require('../services/aiSolver');
const SolverSettings = require('../models/SolverSettings');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// @route   POST /api/ai-solver/generate-rota
// @desc    Generate rota using AI solver
// @access  Private (Managers and Admins only)
router.post('/generate-rota', [
  authenticateToken,
  requireRole(['admin', 'key_worker']),
  body('week_start_date').isISO8601().withMessage('Valid week start date is required'),
  body('week_end_date').isISO8601().withMessage('Valid week end date is required'),
  body('home_ids').custom((value) => {
    // Accept either a single home_id or an array of home_ids
    if (Array.isArray(value)) {
      return value.every(id => require('mongoose').Types.ObjectId.isValid(id));
    } else {
      return require('mongoose').Types.ObjectId.isValid(value);
    }
  }).withMessage('Valid home ID(s) are required'),
  body('service_id').isMongoId().withMessage('Valid service ID is required'),
  body('existing_shifts').optional().isArray().withMessage('Existing shifts must be an array')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { 
      week_start_date, 
      week_end_date, 
      home_ids, 
      service_id, 
      existing_shifts = [] 
    } = req.body;

    // Normalize home_ids to array
    const homeIdArray = Array.isArray(home_ids) ? home_ids : [home_ids];

    // Validate date range
    const startDate = new Date(week_start_date);
    const endDate = new Date(week_end_date);
    const mongoose = require('mongoose');
    const homeIdObjs = homeIdArray.map(homeId => new mongoose.Types.ObjectId(homeId));
    
    if (startDate >= endDate) {
      return res.status(400).json({ 
        error: 'Week start date must be before week end date' 
      });
    }

    // Check if dates are too far in the past (allow current week)
    const now = new Date();
    now.setHours(0, 0, 0, 0); // Reset time to start of day
    const oneWeekAgo = new Date(now);
    oneWeekAgo.setDate(now.getDate() - 7);
    
    if (startDate < oneWeekAgo) {
      return res.status(400).json({ 
        error: 'Cannot generate rota for weeks more than one week in the past' 
      });
    }

    // If no existing shifts provided, fetch them from the database for all homes
    let shifts = existing_shifts;
    if (shifts.length === 0) {
      const Shift = require('../models/Shift');
      
      shifts = await Shift.find({
        home_id: { $in: homeIdObjs },
        date: { $gte: week_start_date, $lte: week_end_date }
      }).populate('service_id', 'name');
      
      if (shifts.length === 0) {
        return res.status(400).json({
          error: 'No shifts found for the specified week and homes',
          details: ['Please create shifts in the rota grid before using AI generation']
        });
      }
    }

    // Cleanup: remove shift assignments pointing to deleted users.
    // This prevents the rota UI from showing "Unknown Staff" when users were deleted
    // but their IDs remained inside `shift.assigned_staff`.
    {
      const Shift = require('../models/Shift');
      const User = require('../models/User');

      const assignedUserIdSet = new Set();
      for (const shift of shifts || []) {
        const assignments = shift.assigned_staff || []
        for (const a of assignments) {
          if (!a || !a.user_id) continue
          assignedUserIdSet.add(a.user_id.toString())
        }
      }

      const assignedUserIds = Array.from(assignedUserIdSet);
      const assignedUserObjs = assignedUserIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (assignedUserObjs.length > 0) {
        const existingUsers = await User.find({ _id: { $in: assignedUserObjs } }, { _id: 1 }).lean();
        const validUserIdSet = new Set(existingUsers.map(u => u._id.toString()));
        const invalidUserIds = assignedUserIds.filter(id => !validUserIdSet.has(id));

        if (invalidUserIds.length > 0) {
          const invalidUserObjs = invalidUserIds.map(id => new mongoose.Types.ObjectId(id));

          await Shift.updateMany(
            {
              home_id: { $in: homeIdObjs },
              date: { $gte: week_start_date, $lte: week_end_date },
              'assigned_staff.user_id': { $in: invalidUserObjs }
            },
            {
              $pull: {
                assigned_staff: { user_id: { $in: invalidUserObjs } }
              }
            }
          )

          // Also clean the in-memory shifts passed to the solver.
          for (const shift of shifts || []) {
            if (!shift.assigned_staff) continue
            shift.assigned_staff = shift.assigned_staff.filter(a => a && a.user_id && validUserIdSet.has(a.user_id.toString()))
          }
        }
      }
    }

    // Initialize AI solver
    const aiSolver = new AISolver();
    
    // Generate rota for multiple homes
    const result = await aiSolver.generateRota(
      startDate,
      endDate,
      homeIdArray,
      service_id,
      shifts
    );

    if (!result.success) {
      return res.status(400).json({ 
        error: 'Failed to generate rota', 
        details: result.error 
      });
    }

    // Create a user-friendly summary of the employment type distribution
    let distributionSummary = '';
    try {
      if (result && result.employment_distribution) {
        const dist = result.employment_distribution;
        distributionSummary = `Employment type distribution (${result.homes_processed} homes): `;
        
        if (dist.fulltime && dist.fulltime.staff_count > 0) {
          distributionSummary += `Full-time (${dist.fulltime.staff_count} staff, avg ${dist.fulltime.average_hours.toFixed(1)}h), `;
        }
        if (dist.parttime && dist.parttime.staff_count > 0) {
          distributionSummary += `Part-time (${dist.parttime.staff_count} staff, avg ${dist.parttime.average_hours.toFixed(1)}h), `;
        }
        if (dist.bank && dist.bank.staff_count > 0) {
          distributionSummary += `Bank (${dist.bank.staff_count} staff, avg ${dist.bank.average_hours.toFixed(1)}h)`;
        }
      }
    } catch (error) {
      console.warn('Error creating employment distribution summary:', error);
      distributionSummary = 'Employment type distribution: Unable to calculate';
    }

    res.json({
      message: `Rota generated successfully for ${result.homes_processed} home(s)`,
      data: result,
      summary: distributionSummary
    });

  } catch (error) {
    console.error('AI Solver rota generation error:', error);
    
    // Provide more detailed error information
    let errorMessage = 'Server error during rota generation';
    if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ 
      error: errorMessage,
      details: error.stack ? error.stack.split('\n').slice(0, 3) : []
    });
  }
});

// @route   POST /api/ai-solver/optimize-rota
// @desc    Optimize existing rota using AI solver
// @access  Private (Managers and Admins only)
router.post('/optimize-rota', [
  authenticateToken,
  requireRole(['admin', 'key_worker']),
  body('rota_id').isMongoId().withMessage('Valid rota ID is required'),
  body('optimization_type').isIn(['staff_distribution', 'shift_timing', 'workload_balance']).withMessage('Valid optimization type is required')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { rota_id, optimization_type } = req.body;

    // TODO: Implement rota optimization logic
    // This would load the existing rota, apply specific optimizations,
    // and return the improved version

    res.json({
      message: 'Rota optimization completed',
      optimization_type,
      improvements: {
        total_penalty_reduction: 25,
        staff_distribution_score: 85,
        workload_balance_score: 78
      }
    });

  } catch (error) {
    console.error('AI Solver rota optimization error:', error);
    res.status(500).json({ 
      error: 'Server error during rota optimization' 
    });
  }
});

// @route   POST /api/ai-solver/validate-rota
// @desc    Validate rota against constraints
// @access  Private (Managers and Admins only)
router.post('/validate-rota', [
  authenticateToken,
  requireRole(['admin', 'key_worker']),
  body('rota_data').isObject().withMessage('Rota data is required')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { rota_data } = req.body;

    // TODO: Implement rota validation logic
    // This would check the rota against all active constraints
    // and return detailed validation results

    const validationResults = {
      is_valid: true,
      hard_constraints: {
        passed: 3,
        failed: 0,
        violations: []
      },
      soft_constraints: {
        score: 85,
        violations: [
          {
            type: 'max_hours_per_week',
            staff_id: 'user123',
            message: 'Staff member exceeds 40 hours per week'
          }
        ]
      },
      recommendations: [
        'Consider redistributing shifts to reduce overtime',
        'Staff member John Doe has 3 consecutive night shifts'
      ]
    };

    res.json({
      message: 'Rota validation completed',
      results: validationResults
    });

  } catch (error) {
    console.error('AI Solver rota validation error:', error);
    res.status(500).json({ 
      error: 'Server error during rota validation' 
    });
  }
});

// Rules the solver always applies; shown read-only on the admin page.
const LOCKED_RULES = [
  { key: 'no_double_booking', name: 'No double booking', description: 'Staff are never auto-assigned to overlapping shifts.' },
  { key: 'respect_time_off', name: 'Respect approved time off', description: 'Staff on approved leave are never auto-assigned.' },
  { key: 'respect_unavailability', name: 'Respect unavailability', description: 'Staff who marked a day as unavailable are never auto-assigned that day.' },
  { key: 'home_access', name: 'Home access', description: 'Staff are only assigned to homes they are linked to.' },
  { key: 'one_to_one_manual', name: '1-to-1 shifts are manual', description: '1-to-1 shifts are created and assigned by admins only.' }
];

// Copy only the keys that exist in `shape` (DEFAULTS), so unknown or system fields
// (_id, updated_by, timestamps) in the request body are ignored.
function pickKnown(input, shape) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(shape)) {
    if (!(key in input)) continue;
    const ref = shape[key];
    const val = input[key];
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      out[key] = pickKnown(val, ref);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    out[key] = val && typeof val === 'object' && !Array.isArray(val) && base[key] && typeof base[key] === 'object'
      ? deepMerge(base[key], val)
      : val;
  }
  return out;
}

function constraintsPayload(settings) {
  return {
    settings,
    defaults: SolverSettings.DEFAULTS,
    locked_rules: LOCKED_RULES,
    roles: SolverSettings.ROLES
  };
}

// @route   GET /api/ai-solver/constraints
// @desc    Get the rules the AI solver uses (org-wide)
// @access  Private (Admins and key workers)
router.get('/constraints', [
  authenticateToken,
  requireRole(['admin', 'key_worker'])
], async (req, res) => {
  try {
    const settings = await SolverSettings.getSettings();
    res.json(constraintsPayload(settings));
  } catch (error) {
    console.error('AI Solver constraints error:', error);
    res.status(500).json({ error: 'Server error while retrieving constraints' });
  }
});

// @route   PUT /api/ai-solver/constraints
// @desc    Update the rules the AI solver uses
// @access  Private (Admins only)
router.put('/constraints', [
  authenticateToken,
  requireRole(['admin'])
], async (req, res) => {
  try {
    const settings = await SolverSettings.getSettings();
    const current = settings.toObject();
    const patch = pickKnown(req.body, SolverSettings.DEFAULTS);
    settings.set(deepMerge(current, patch));
    settings.updated_by = req.user._id;
    await settings.save();
    res.json(constraintsPayload(settings));
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation failed',
        details: Object.values(error.errors).map((e) => ({ path: e.path, msg: e.message }))
      });
    }
    console.error('AI Solver constraint update error:', error);
    res.status(500).json({ error: 'Server error while updating constraints' });
  }
});

// @route   POST /api/ai-solver/constraints/reset
// @desc    Restore every solver rule to its default
// @access  Private (Admins only)
router.post('/constraints/reset', [
  authenticateToken,
  requireRole(['admin'])
], async (req, res) => {
  try {
    const settings = await SolverSettings.resetToDefaults(req.user._id);
    res.json(constraintsPayload(settings));
  } catch (error) {
    console.error('AI Solver constraint reset error:', error);
    res.status(500).json({ error: 'Server error while resetting constraints' });
  }
});

// @route   GET /api/ai-solver/performance
// @desc    Get AI solver performance metrics
// @access  Private (Managers and Admins only)
router.get('/performance', [
  authenticateToken,
  requireRole(['admin', 'key_worker'])
], async (req, res) => {
  try {
    const { home_id, date_range } = req.query;
    
    // TODO: Implement performance metrics calculation
    const performanceMetrics = {
      total_rotas_generated: 45,
      average_generation_time: '2.3 seconds',
      constraint_violation_rate: '8.5%',
      staff_satisfaction_score: 82,
      optimization_improvements: {
        average_penalty_reduction: '23%',
        staff_distribution_improvement: '18%',
        workload_balance_improvement: '15%'
      }
    };

    res.json({
      metrics: performanceMetrics,
      message: 'Performance metrics retrieved successfully'
    });

  } catch (error) {
    console.error('AI Solver performance error:', error);
    res.status(500).json({ 
      error: 'Server error while retrieving performance metrics' 
    });
  }
});

module.exports = router;
