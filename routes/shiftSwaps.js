const express = require('express');
const router = express.Router();
const ShiftSwap = require('../models/ShiftSwap');
const Shift = require('../models/Shift');
const { requireRole, authenticateToken } = require('../middleware/auth');
const shiftSwapService = require('../services/shiftSwapService');

// Get all shift swaps for a user (both as requester and target)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, type } = req.query;
    const userId = req.user._id.toString();
    
    let filter = {
      $or: [
        { requester_id: userId },
        { target_user_id: userId }
      ]
    };

    if (status) {
      filter.status = status;
    }

    const swaps = await ShiftSwap.find(filter)
      .populate('requester_shift_id', 'date start_time end_time shift_type home_id service_id')
      .populate('target_shift_id', 'date start_time end_time shift_type home_id service_id')
      .populate('requester_id', 'name email')
      .populate('target_user_id', 'name email')
      .populate('home_id', 'name location')
      .sort({ created_at: -1 });

    // Filter by type if specified
    let filteredSwaps = swaps;
    if (type === 'sent') {
      filteredSwaps = swaps.filter(swap => swap.requester_id._id.toString() === userId);
    } else if (type === 'received') {
      filteredSwaps = swaps.filter(swap => swap.target_user_id._id.toString() === userId);
    }

    res.json(filteredSwaps);
  } catch (error) {
    console.error('Error fetching shift swaps:', error);
    res.status(500).json({ error: 'Failed to fetch shift swaps' });
  }
});

// Get pending swap requests for a user (where they need to respond)
router.get('/pending', authenticateToken, async (req, res) => {
  try {
    const userId = req.user._id.toString();
    
    const pendingSwaps = await ShiftSwap.findPendingSwapsForUser(userId)
      .populate('requester_shift_id', 'date start_time end_time shift_type home_id service_id')
      .populate('target_shift_id', 'date start_time end_time shift_type home_id service_id')
      .populate('requester_id', 'name email')
      .populate('home_id', 'name location')
      .sort({ created_at: -1 });

    res.json(pendingSwaps);
  } catch (error) {
    console.error('Error fetching pending swaps:', error);
    res.status(500).json({ error: 'Failed to fetch pending swaps' });
  }
});

// Get shift swap by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const swap = await ShiftSwap.findById(req.params.id)
      .populate('requester_shift_id', 'date start_time end_time shift_type home_id service_id assigned_staff')
      .populate('target_shift_id', 'date start_time end_time shift_type home_id service_id assigned_staff')
      .populate('requester_id', 'name email')
      .populate('target_user_id', 'name email')
      .populate('home_id', 'name location');

    if (!swap) {
      return res.status(404).json({ error: 'Shift swap not found' });
    }

    // Check if user has permission to view this swap
    const userId = req.user._id.toString();
    if (swap.requester_id._id.toString() !== userId && swap.target_user_id._id.toString() !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(swap);
  } catch (error) {
    console.error('Error fetching shift swap:', error);
    res.status(500).json({ error: 'Failed to fetch shift swap' });
  }
});

// Create a new shift swap request
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { requester_shift_id, target_shift_id, requester_message } = req.body;
    const requesterId = req.user._id.toString();

    // Validate required fields
    if (!requester_shift_id || !target_shift_id) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: ['requester_shift_id and target_shift_id are required']
      });
    }

    // Get the shifts to validate they exist and get target user
    const [requesterShift, targetShift] = await Promise.all([
      Shift.findById(requester_shift_id).populate('assigned_staff.user_id', 'name email homes'),
      Shift.findById(target_shift_id).populate('assigned_staff.user_id', 'name email homes')
    ]);

    if (!requesterShift || !targetShift) {
      return res.status(404).json({ 
        error: 'One or both shifts not found' 
      });
    }

    // Verify requester is assigned to their shift
    const requesterAssigned = requesterShift.assigned_staff.some(
      assignment => assignment.user_id._id.toString() === requesterId
    );

    if (!requesterAssigned) {
      return res.status(400).json({ 
        error: 'You are not assigned to the shift you want to give up' 
      });
    }

    // Find the target user (user assigned to the target shift)
    const targetUserAssignment = targetShift.assigned_staff.find(
      assignment => assignment.user_id._id.toString() !== requesterId
    );

    if (!targetUserAssignment) {
      return res.status(400).json({ 
        error: 'No other user is assigned to the target shift' 
      });
    }

    const targetUserId = targetUserAssignment.user_id._id.toString();

    // Prevent self-swap
    if (requesterId === targetUserId) {
      return res.status(400).json({ 
        error: 'Cannot swap with yourself' 
      });
    }

    // Check for conflicts
    const conflictCheck = await shiftSwapService.checkSwapConflicts(
      requester_shift_id,
      target_shift_id,
      requesterId,
      targetUserId
    );

    if (conflictCheck.hasConflict) {
      return res.status(409).json({
        error: 'Shift swap conflicts detected',
        conflicts: conflictCheck.conflicts,
        message: 'The requested swap would create scheduling conflicts'
      });
    }

    // Create the swap request
    const swapData = {
      requester_shift_id,
      target_shift_id,
      requester_id: requesterId,
      target_user_id: targetUserId,
      requester_message: requester_message || '',
      home_id: requesterShift.home_id, // Use requester's shift home as primary
      conflict_check: {
        has_conflict: false,
        conflict_details: []
      }
    };

    const swap = new ShiftSwap(swapData);
    await swap.save();

    // Populate the response
    await swap.populate('requester_shift_id', 'date start_time end_time shift_type home_id service_id assigned_staff');
    await swap.populate('target_shift_id', 'date start_time end_time shift_type home_id service_id assigned_staff');
    await swap.populate('requester_id', 'name email');
    await swap.populate('target_user_id', 'name email');
    await swap.populate('home_id', 'name location');

    res.status(201).json(swap);
  } catch (error) {
    console.error('Error creating shift swap:', error);
    
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    } else {
      res.status(500).json({ error: 'Failed to create shift swap request' });
    }
  }
});

// Approve a shift swap request
router.post('/:id/approve', authenticateToken, async (req, res) => {
  try {
    const { response_message } = req.body;
    const userId = req.user._id.toString();

    const swap = await ShiftSwap.findById(req.params.id)
      .populate('requester_shift_id target_shift_id requester_id target_user_id');

    if (!swap) {
      return res.status(404).json({ error: 'Shift swap not found' });
    }

    // Check if user is the target user (the one who needs to approve)
    if (swap.target_user_id._id.toString() !== userId) {
      return res.status(403).json({ 
        error: 'Only the target user can approve this swap request' 
      });
    }

    // Check if swap is still pending
    if (swap.status !== 'pending') {
      return res.status(400).json({ 
        error: 'This swap request is no longer pending' 
      });
    }

    // Check if swap has expired
    if (swap.isExpired) {
      return res.status(400).json({ 
        error: 'This swap request has expired' 
      });
    }

    // Re-check for conflicts before approval (in case something changed)
    const conflictCheck = await shiftSwapService.checkSwapConflicts(
      swap.requester_shift_id._id.toString(),
      swap.target_shift_id._id.toString(),
      swap.requester_id._id.toString(),
      swap.target_user_id._id.toString(),
      swap._id.toString() // Exclude the current swap from conflict check
    );

    if (conflictCheck.hasConflict) {
      return res.status(409).json({
        error: 'Conflicts detected during approval',
        conflicts: conflictCheck.conflicts,
        message: 'The swap cannot be approved due to scheduling conflicts'
      });
    }

    // Approve the swap
    swap.approve(response_message);
    await swap.save();

    // Execute the swap immediately after approval
    try {
      const executionResult = await shiftSwapService.executeSwap(swap._id);
      
      res.json({
        ...swap.toObject(),
        executionResult,
        message: 'Shift swap approved and executed successfully'
      });
    } catch (executionError) {
      console.error('Error executing approved swap:', executionError);
      // The swap is still approved, but execution failed
      res.status(500).json({
        ...swap.toObject(),
        error: 'Swap approved but execution failed',
        message: 'The swap was approved but could not be executed. Please contact support.'
      });
    }

  } catch (error) {
    console.error('Error approving shift swap:', error);
    res.status(500).json({ error: 'Failed to approve shift swap' });
  }
});

// Reject a shift swap request
router.post('/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { response_message } = req.body;
    const userId = req.user._id.toString();

    const swap = await ShiftSwap.findById(req.params.id);

    if (!swap) {
      return res.status(404).json({ error: 'Shift swap not found' });
    }

    // Check if user is the target user (the one who needs to respond)
    if (swap.target_user_id.toString() !== userId) {
      return res.status(403).json({ 
        error: 'Only the target user can reject this swap request' 
      });
    }

    // Check if swap is still pending
    if (swap.status !== 'pending') {
      return res.status(400).json({ 
        error: 'This swap request is no longer pending' 
      });
    }

    // Reject the swap
    swap.reject(response_message);
    await swap.save();

    res.json(swap);
  } catch (error) {
    console.error('Error rejecting shift swap:', error);
    res.status(500).json({ error: 'Failed to reject shift swap' });
  }
});

// Cancel a shift swap request (by the requester)
router.post('/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user._id.toString();

    const swap = await ShiftSwap.findById(req.params.id);

    if (!swap) {
      return res.status(404).json({ error: 'Shift swap not found' });
    }

    // Check if user is the requester
    if (swap.requester_id.toString() !== userId) {
      return res.status(403).json({ 
        error: 'Only the requester can cancel this swap request' 
      });
    }

    // Check if swap is still pending
    if (swap.status !== 'pending') {
      return res.status(400).json({ 
        error: 'This swap request is no longer pending' 
      });
    }

    // Cancel the swap
    swap.cancel();
    await swap.save();

    res.json(swap);
  } catch (error) {
    console.error('Error cancelling shift swap:', error);
    res.status(500).json({ error: 'Failed to cancel shift swap' });
  }
});

// Get available shifts for swapping (shifts the user can request to swap with)
router.get('/available-shifts/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id.toString();
    const { start_date, end_date, home_id } = req.query;

    // Only allow users to see their own available shifts or if they're admin/manager
    if (userId !== currentUserId && !['admin', 'home_manager', 'senior_staff'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get user's current shifts in the date range
    const userShifts = await Shift.find({
      'assigned_staff.user_id': userId,
      is_active: true,
      ...(start_date && end_date && { date: { $gte: start_date, $lte: end_date } }),
      ...(home_id && { home_id })
    }).populate('service_id', 'name').populate('home_id', 'name');

    // For each shift, find other shifts in the same home that could be swapped
    const availableSwaps = [];

    for (const userShift of userShifts) {
      // Find other shifts in the same home on the same date
      const otherShifts = await Shift.find({
        home_id: userShift.home_id,
        date: userShift.date,
        'assigned_staff.user_id': { $ne: userId },
        is_active: true,
        _id: { $ne: userShift._id }
      }).populate('assigned_staff.user_id', 'name email').populate('service_id', 'name');

      for (const otherShift of otherShifts) {
        // Check if there are other users assigned to this shift
        const otherUsers = otherShift.assigned_staff.filter(
          assignment => assignment.user_id._id.toString() !== userId
        );

        if (otherUsers.length > 0) {
          availableSwaps.push({
            user_shift: userShift,
            target_shift: otherShift,
            potential_swappers: otherUsers.map(u => ({
              user_id: u.user_id._id,
              name: u.user_id.name,
              email: u.user_id.email
            }))
          });
        }
      }
    }

    res.json(availableSwaps);
  } catch (error) {
    console.error('Error fetching available shifts for swap:', error);
    res.status(500).json({ error: 'Failed to fetch available shifts' });
  }
});

// Get swap statistics for a user
router.get('/stats/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id.toString();

    // Only allow users to see their own stats or if they're admin/manager
    if (userId !== currentUserId && !['admin', 'home_manager', 'senior_staff'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const stats = await ShiftSwap.aggregate([
      {
        $match: {
          $or: [
            { requester_id: userId },
            { target_user_id: userId }
          ]
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const result = {
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      completed: 0
    };

    stats.forEach(stat => {
      result[stat._id] = stat.count;
      result.total += stat.count;
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching swap stats:', error);
    res.status(500).json({ error: 'Failed to fetch swap statistics' });
  }
});

module.exports = router;
