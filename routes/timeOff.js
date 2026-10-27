const express = require('express');
const router = express.Router();
const TimeOffRequest = require('../models/TimeOffRequest');
const { requireRole } = require('../middleware/auth');
const {
  findTimetableConflictForLeave,
  buildAutoDenialReason,
  syncAvailabilityForApprovedLeave,
  releaseAvailabilityForCancelledLeave,
  findHomeLeaveLimitConflict,
  buildHomeLeaveLimitMessage
} = require('../services/timeOffService');

const APPROVER_ROLES = ['admin', 'key_worker', 'senior_staff'];
// Only admins may approve or deny leave; key workers can view and manage requests but not decide them.
const DECISION_ROLES = ['admin'];

// Fields staff may set when submitting or editing a request. Status, approval and
// limit-override fields only change through the approve/deny endpoints.
const EDITABLE_FIELDS = ['start_date', 'end_date', 'reason', 'request_type', 'is_urgent'];

const pickEditable = (body) =>
  Object.fromEntries(EDITABLE_FIELDS.filter((f) => body?.[f] !== undefined).map((f) => [f, body[f]]));

const isOwner = (request, user) => request.user_id?.toString() === user._id.toString();

async function applyHomeLeaveLimitWarning(request) {
  const limitConflict = await findHomeLeaveLimitConflict(
    request.user_id, request.start_date, request.end_date, request.request_type, request._id
  );
  request.home_leave_limit_warning = limitConflict
    ? { ...limitConflict, message: buildHomeLeaveLimitMessage(limitConflict) }
    : undefined;
}

// Get all time-off requests
router.get('/', async (req, res) => {
  try {
    const { user_id, status, home_id, start_date, end_date } = req.query;
    const filter = {};
    
    if (user_id) filter.user_id = user_id;
    if (status) filter.status = status;
    if (start_date || end_date) {
      filter.start_date = {};
      if (start_date) filter.start_date.$gte = start_date;
      if (end_date) filter.start_date.$lte = end_date;
    }
    
    let requests = await TimeOffRequest.find(filter)
      .populate('user_id', 'name email role homes')
      .populate('approved_by', 'name email role');
    
    // Filter by home_id if specified (through user's homes)
    if (home_id) {
      requests = requests.filter(request => {
        if (!request.user_id || !request.user_id.homes) return false;
        
        // Check if user belongs to the specified home
        return request.user_id.homes.some(home => {
          const homeId = typeof home.home_id === 'string' ? home.home_id : home.home_id.toString();
          return homeId === home_id;
        });
      });
    }
    
    res.json(requests);
  } catch (error) {
    console.error('Error fetching time-off requests:', error);
    res.status(500).json({ error: 'Failed to fetch time-off requests' });
  }
});

// Get time-off request by ID
router.get('/:id', async (req, res) => {
  try {
    const request = await TimeOffRequest.findById(req.params.id)
      .populate('user_id', 'name email role')
      .populate('approved_by', 'name email role')
      .populate('home_id', 'name');
    
    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    
    res.json(request);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch time-off request' });
  }
});

// Create new time-off request
router.post('/', async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.body;

    if (!user_id || !start_date || !end_date) {
      return res.status(400).json({ error: 'user_id, start_date, and end_date are required' });
    }

    if (String(user_id) !== req.user._id.toString() && !APPROVER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'You can only request time off for yourself' });
    }

    const fields = { ...pickEditable(req.body), user_id };

    const conflict = await findTimetableConflictForLeave(user_id, start_date, end_date);

    if (conflict) {
      const request = new TimeOffRequest({
        ...fields,
        status: 'denied',
        denial_reason: buildAutoDenialReason(conflict),
        approved_at: new Date()
      });
      await request.save();
      await request.populate('user_id', 'name email role');

      return res.status(201).json({
        ...request.toObject(),
        auto_rejected: true,
        message: request.denial_reason
      });
    }

    // Over the per-home limit is a soft constraint: the request is still submitted, but
    // flagged so that only an admin can approve it.
    const request = new TimeOffRequest(fields);
    await applyHomeLeaveLimitWarning(request);
    await request.save();
    res.status(201).json(request);
  } catch (error) {
    console.error('Error creating time-off request:', error);
    res.status(400).json({
      error: 'Failed to create time-off request',
      details: error.message
    });
  }
});

// Update time-off request (pending only; the requester or an approver). Status can't be
// changed here, so edits can't skip the approval checks.
router.put('/:id', async (req, res) => {
  try {
    const request = await TimeOffRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    if (!isOwner(request, req.user) && !APPROVER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'You can only edit your own time-off requests' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Only pending requests can be edited; this one is ${request.status}` });
    }

    request.set(pickEditable(req.body));

    const conflict = await findTimetableConflictForLeave(request.user_id, request.start_date, request.end_date);
    if (conflict) {
      return res.status(400).json({
        error: 'Cannot request leave for scheduled dates',
        details: buildAutoDenialReason(conflict)
      });
    }

    await applyHomeLeaveLimitWarning(request);
    await request.save();
    res.json(request);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update time-off request', details: error.message });
  }
});

// Delete time-off request (requesters may withdraw their own pending requests; approvers
// may delete any)
router.delete('/:id', async (req, res) => {
  try {
    const request = await TimeOffRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    if (!APPROVER_ROLES.includes(req.user.role)) {
      if (!isOwner(request, req.user)) {
        return res.status(403).json({ error: 'You can only delete your own time-off requests' });
      }
      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending requests can be withdrawn; ask an admin to cancel approved leave' });
      }
    }
    // Cancelling approved leave reverses an approval decision, so it is admin-only like approve/deny.
    if (request.status === 'approved' && !DECISION_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only an admin can cancel approved leave' });
    }
    await request.deleteOne();
    if (request.status === 'approved') {
      await releaseAvailabilityForCancelledLeave(request);
    }
    res.json({ message: 'Time-off request deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete time-off request' });
  }
});

// Approve time-off request
router.post('/:id/approve', requireRole(DECISION_ROLES), async (req, res) => {
  try {
    console.log('Approving time-off request:', req.params.id, 'by user:', req.user._id);
    
    const request = await TimeOffRequest.findById(req.params.id);
    
    if (!request) {
      console.log('Time-off request not found:', req.params.id);
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    
    console.log('Found request:', request.status, 'Current status:', request.status);
    
    // Check if request is already processed
    if (request.status !== 'pending') {
      return res.status(400).json({ 
        error: 'Request has already been processed',
        details: `This request is currently ${request.status} and cannot be approved again.`
      });
    }
    
    const conflict = await findTimetableConflictForLeave(
      request.user_id,
      request.start_date,
      request.end_date
    );

    if (conflict) {
      return res.status(400).json({
        error: 'Cannot approve leave for scheduled dates',
        details: buildAutoDenialReason(conflict)
      });
    }

    // Recheck the per-home limit now: other leave may have been approved since submission.
    const limitConflict = await findHomeLeaveLimitConflict(
      request.user_id,
      request.start_date,
      request.end_date,
      request.request_type,
      request._id
    );

    if (limitConflict) {
      const message = buildHomeLeaveLimitMessage(limitConflict);
      if (req.body?.override_home_leave_limit !== true) {
        return res.status(409).json({
          error: 'Home leave limit exceeded',
          code: 'HOME_LEAVE_LIMIT',
          details: message,
          conflict: limitConflict
        });
      }
      request.home_leave_limit_warning = { ...limitConflict, message };
      request.home_leave_limit_override = { approved_by: req.user._id, approved_at: new Date() };
    }

    request.approve(req.user._id);
    await request.save();

    await syncAvailabilityForApprovedLeave(request);

    console.log('Request approved successfully');

    await request.populate('user_id', 'name email role');
    await request.populate('approved_by', 'name email role');

    res.json(request);
  } catch (error) {
    console.error('Error approving time-off request:', error);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      stack: error.stack
    });
    res.status(400).json({ 
      error: 'Failed to approve time-off request',
      details: error.message 
    });
  }
});

// Deny time-off request
router.post('/:id/deny', requireRole(DECISION_ROLES), async (req, res) => {
  try {
    console.log('Denying time-off request:', req.params.id, 'by user:', req.user._id, 'reason:', req.body.reason);
    
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required for denial' });
    }
    
    const request = await TimeOffRequest.findById(req.params.id);
    
    if (!request) {
      console.log('Time-off request not found:', req.params.id);
      return res.status(404).json({ error: 'Time-off request not found' });
    }
    
    console.log('Found request:', request.status, 'Current status:', request.status);
    
    // Check if request is already processed
    if (request.status !== 'pending') {
      console.log('Request already processed:', request.status);
      return res.status(400).json({ 
        error: 'Request has already been processed',
        details: `This request is currently ${request.status} and cannot be denied.`
      });
    }
    
    // Call the deny method and save the changes
    request.deny(req.user._id, reason); // Pass the denier's ID and reason
    await request.save();
    
    console.log('Request denied successfully');
    
    // Populate user info for the response
    await request.populate('user_id', 'name email role');
    await request.populate('approved_by', 'name email role');
    
    res.json(request);
  } catch (error) {
    console.error('Error denying time-off request:', error);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Failed to deny time-off request',
      details: error.message 
    });
  }
});

// Get user time-off requests
router.get('/user/:userId', async (req, res) => {
  try {
    const { status, start_date, end_date } = req.query;
    const filter = { user_id: req.params.userId };
    
    if (status) filter.status = status;
    if (start_date || end_date) {
      filter.start_date = {};
      if (start_date) filter.start_date.$gte = start_date;
      if (end_date) filter.start_date.$lte = end_date;
    }
    
    const requests = await TimeOffRequest.find(filter)
      .populate('user_id', 'name email role')
      .populate('approved_by', 'name email role')
      .populate('home_id', 'name');
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user time-off requests' });
  }
});

module.exports = router;
