const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const ShiftSwap = require('../models/ShiftSwap');
const Shift = require('../models/Shift');
const { requireRole, authenticateToken } = require('../middleware/auth');
const shiftSwapService = require('../services/shiftSwapService');

// 409 body asking the caller to resend with `rest_consent: true` after showing the warnings.
function restConsentRequired(restWarnings) {
  return {
    error: 'Rest consent required',
    consent_required: true,
    rest_warnings: restWarnings,
    message: 'This swap breaks the minimum rest rule. It can go ahead only if you consent; it will be flagged for admin review.'
  };
}

// Get all shift swaps for a user (both as requester and target)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, type } = req.query;
    const userId = req.user._id.toString();
    await ShiftSwap.expireStale();
    
    let filter = {
      $or: [
        { requester_id: userId },
        { target_user_id: userId }
      ]
    };

    // One status, or a comma-separated list (e.g. the history tab).
    if (status) {
      const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
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
    await ShiftSwap.expireStale();
    
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
    const { requester_shift_id, target_shift_id, target_user_id, requester_message, rest_consent } = req.body;
    const requesterId = req.user._id.toString();
    await ShiftSwap.expireStale();

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

    // The colleague to swap with: the one chosen (must be on the target shift), or, when not
    // given, the target shift's only other assignee.
    const otherAssignments = targetShift.assigned_staff.filter(
      assignment => assignment.user_id && assignment.user_id._id.toString() !== requesterId
    );
    let targetUserAssignment;
    if (target_user_id) {
      targetUserAssignment = otherAssignments.find(a => a.user_id._id.toString() === String(target_user_id));
      if (!targetUserAssignment) {
        return res.status(400).json({ error: 'The selected colleague is not assigned to the target shift' });
      }
    } else if (otherAssignments.length === 1) {
      targetUserAssignment = otherAssignments[0];
    } else if (otherAssignments.length > 1) {
      return res.status(400).json({ error: 'Choose which colleague on the target shift to swap with' });
    }

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

    const restWarnings = conflictCheck.restWarnings.map((w) => w.message);
    if (restWarnings.length && rest_consent !== true) {
      return res.status(409).json(restConsentRequired(restWarnings));
    }

    // Create the swap request
    const swapData = {
      requester_shift_id,
      target_shift_id,
      requester_id: requesterId,
      target_user_id: targetUserId,
      requester_message: requester_message || '',
      home_id: requesterShift.home_id, // Use requester's shift home as primary
      expires_at: shiftSwapService.expiryFor(requesterShift, targetShift),
      rest_warnings: restWarnings,
      requester_rest_consent_at: restWarnings.length ? new Date() : null,
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
    const { response_message, rest_consent } = req.body;
    const userId = req.user._id.toString();
    await ShiftSwap.expireStale();

    const swap = await ShiftSwap.findById(req.params.id);

    if (!swap) {
      return res.status(404).json({ error: 'Shift swap not found' });
    }

    // Check if user is the target user (the one who needs to approve)
    if (swap.target_user_id.toString() !== userId) {
      return res.status(403).json({ 
        error: 'Only the target user can approve this swap request' 
      });
    }

    if (swap.status === 'expired') {
      return res.status(400).json({ error: 'This swap request has expired' });
    }
    if (swap.status !== 'pending') {
      return res.status(400).json({ 
        error: 'This swap request is no longer pending' 
      });
    }

    // Re-check for conflicts before approval (in case something changed)
    const conflictCheck = await shiftSwapService.checkSwapConflicts(
      swap.requester_shift_id.toString(),
      swap.target_shift_id.toString(),
      swap.requester_id.toString(),
      swap.target_user_id.toString(),
      swap._id.toString() // Exclude the current swap from conflict check
    );

    if (conflictCheck.hasConflict) {
      return res.status(409).json({
        error: 'Conflicts detected during approval',
        conflicts: conflictCheck.conflicts,
        message: 'The swap cannot be approved due to scheduling conflicts'
      });
    }

    // A rest-rule breach needs both staff's consent. Re-checked now, so the requester must also
    // have consented if the breach only arose after they sent the request.
    const restWarnings = conflictCheck.restWarnings;
    if (restWarnings.length) {
      if (!swap.requester_rest_consent_at) {
        return res.status(409).json({
          error: 'The requester has not consented to the rest exception',
          message: 'This swap now breaks the minimum rest rule, which the requester did not consent to. Ask them to send a new request.',
          rest_warnings: restWarnings.map((w) => w.message)
        });
      }
      if (rest_consent !== true) {
        return res.status(409).json(restConsentRequired(restWarnings.map((w) => w.message)));
      }
    }

    // Claim the request atomically so a double-submit can't execute it twice.
    const claimed = await ShiftSwap.findOneAndUpdate(
      { _id: swap._id, status: 'pending', expires_at: { $gt: new Date() } },
      {
        $set: {
          status: 'approved',
          response_message: response_message || '',
          responded_at: new Date(),
          rest_warnings: restWarnings.map((w) => w.message),
          target_rest_consent_at: restWarnings.length ? new Date() : null
        }
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(400).json({ error: 'This swap request is no longer pending' });
    }

    try {
      // Whoever ends up short of rest is flagged for admin review.
      const executionResult = await shiftSwapService.executeSwap(claimed._id, {
        requester: restWarnings.some((w) => w.user === 'requester'),
        target_user: restWarnings.some((w) => w.user === 'target_user')
      });
      const completed = await ShiftSwap.findById(claimed._id);
      res.json({
        ...completed.toObject(),
        executionResult,
        message: 'Shift swap approved and executed successfully'
      });
    } catch (executionError) {
      // Nothing on the rota changed; put the request back to pending so it can be retried
      // or rejected.
      await ShiftSwap.updateOne(
        { _id: claimed._id, status: 'approved' },
        { $set: { status: 'pending', target_rest_consent_at: null }, $unset: { responded_at: 1 } }
      );
      if (executionError instanceof shiftSwapService.SwapExecutionError) {
        return res.status(409).json({
          error: executionError.message,
          message: 'The swap could not be completed because the rota has changed. Nothing was changed.'
        });
      }
      console.error('Error executing approved swap:', executionError);
      res.status(500).json({
        error: 'Swap could not be executed',
        message: 'The swap could not be completed. Nothing was changed; please try again.'
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
    await ShiftSwap.expireStale();

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
    await ShiftSwap.expireStale();

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
    if (userId !== currentUserId && !['admin', 'key_worker', 'senior_staff'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await ShiftSwap.expireStale();
    const availableSwaps = await shiftSwapService.findSwapOptions(userId, { start_date, end_date, home_id });
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
    if (userId !== currentUserId && !['admin', 'key_worker', 'senior_staff'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    await ShiftSwap.expireStale();
    // aggregate() doesn't cast, so match on ObjectIds.
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const stats = await ShiftSwap.aggregate([
      {
        $match: {
          $or: [
            { requester_id: userObjectId },
            { target_user_id: userObjectId }
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
      completed: 0,
      expired: 0
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
