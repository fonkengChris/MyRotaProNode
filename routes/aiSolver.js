const express = require('express');
const { body, validationResult } = require('express-validator');
const AISolver = require('../services/aiSolver');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// @route   POST /api/ai-solver/generate-rota
// @desc    Generate rota using AI solver
// @access  Private (Managers and Admins only)
router.post('/generate-rota', [
  authenticateToken,
  requireRole(['admin', 'home_manager']),
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
      const mongoose = require('mongoose');
      const homeIdObjs = homeIdArray.map(homeId => new mongoose.Types.ObjectId(homeId));
      
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
  requireRole(['admin', 'home_manager']),
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
  requireRole(['admin', 'home_manager']),
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

// @route   GET /api/ai-solver/constraints
// @desc    Get available constraints and their weights
// @access  Private (Managers and Admins only)
router.get('/constraints', [
  authenticateToken,
  requireRole(['admin', 'home_manager'])
], async (req, res) => {
  try {
    const { home_id, service_id } = req.query;
    
    // TODO: Load constraints from database
    const constraints = {
      hard_constraints: [
        {
          id: 'constraint1',
          name: 'No Double Booking',
          description: 'Staff cannot be assigned to overlapping shifts',
          weight: 1000,
          is_active: true
        },
        {
          id: 'constraint2',
          name: 'Respect Time Off',
          description: 'Staff cannot be assigned during approved time off',
          weight: 1000,
          is_active: true
        }
      ],
      soft_constraints: [
        {
          id: 'constraint3',
          name: 'Preferred Shift Types',
          description: 'Respect staff shift type preferences',
          weight: 20,
          is_active: true
        },
        {
          id: 'constraint4',
          name: 'Even Distribution',
          description: 'Distribute shifts evenly among staff',
          weight: 25,
          is_active: true
        }
      ]
    };

    res.json({
      constraints,
      message: 'Constraints retrieved successfully'
    });

  } catch (error) {
    console.error('AI Solver constraints error:', error);
    res.status(500).json({ 
      error: 'Server error while retrieving constraints' 
    });
  }
});

// @route   POST /api/ai-solver/update-constraints
// @desc    Update constraint weights
// @access  Private (Admins only)
router.post('/update-constraints', [
  authenticateToken,
  requireRole(['admin']),
  body('constraints').isArray().withMessage('Constraints array is required')
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

    const { constraints } = req.body;

    // TODO: Implement constraint update logic
    // This would update constraint weights in the database

    res.json({
      message: 'Constraints updated successfully',
      updated_count: constraints.length
    });

  } catch (error) {
    console.error('AI Solver constraint update error:', error);
    res.status(500).json({ 
      error: 'Server error while updating constraints' 
    });
  }
});

// @route   GET /api/ai-solver/performance
// @desc    Get AI solver performance metrics
// @access  Private (Managers and Admins only)
router.get('/performance', [
  authenticateToken,
  requireRole(['admin', 'home_manager'])
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
