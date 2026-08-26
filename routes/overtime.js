const express = require('express');
const router = express.Router();
const OvertimeRequest = require('../models/OvertimeRequest');
const Shift = require('../models/Shift');
const { requireRole } = require('../middleware/auth');
const { shiftEndDate, OVERTIME_ELIGIBLE_MINUTES } = require('../utils/shiftTime');

// List overtime requests. Staff see their own; managers/admins can filter by status/home.
router.get('/', async (req, res) => {
  try {
    const { status, home_id } = req.query;
    const currentUser = req.user;
    const isManager = ['admin', 'home_manager'].includes(currentUser.role);

    const filter = {};
    if (!isManager) {
      filter.user_id = currentUser._id;
    }
    if (status) filter.status = status;
    if (home_id) filter.home_id = home_id;

    const requests = await OvertimeRequest.find(filter)
      .populate('user_id', 'name email role homes')
      .populate('approved_by', 'name email role')
      .populate('shift_id', 'date start_time end_time shift_type home_id')
      .sort({ submitted_at: -1 });

    res.json(requests);
  } catch (error) {
    console.error('Error listing overtime requests:', error);
    res.status(500).json({ error: 'Failed to fetch overtime requests' });
  }
});

// Create an overtime request for the caller's own clocked-out shift.
router.post('/', async (req, res) => {
  try {
    const { shift_id, requested_minutes, reason } = req.body;
    const currentUser = req.user;

    if (!shift_id) {
      return res.status(400).json({ error: 'shift_id is required' });
    }

    const shift = await Shift.findById(shift_id);
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const assignment = shift.assigned_staff.find(
      (a) => a.user_id.toString() === currentUser._id.toString() && a.status !== 'declined'
    );
    if (!assignment) {
      return res.status(403).json({ error: 'You are not assigned to this shift' });
    }
    if (!assignment.clock_out_time) {
      return res.status(400).json({ error: 'You must clock out before requesting overtime' });
    }

    // Verify eligibility server-side: actual clock-out must exceed scheduled end by the threshold.
    const scheduledEnd = shiftEndDate(shift);
    const eligibleMinutes = Math.round(
      (assignment.clock_out_time.getTime() - scheduledEnd.getTime()) / 60000
    );
    if (eligibleMinutes <= OVERTIME_ELIGIBLE_MINUTES) {
      return res.status(400).json({
        error: 'Shift is not eligible for overtime',
        message: `Clock-out must be more than ${OVERTIME_ELIGIBLE_MINUTES} minutes past the scheduled end.`
      });
    }

    // Requested minutes cannot exceed what was actually worked past the scheduled end.
    const minutes = Number(requested_minutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      return res.status(400).json({ error: 'requested_minutes must be a positive number' });
    }
    if (minutes > eligibleMinutes) {
      return res.status(400).json({
        error: 'Requested minutes exceed the extra time worked',
        message: `You worked ${eligibleMinutes} minutes past the scheduled end.`
      });
    }

    const overtime = new OvertimeRequest({
      shift_id: shift._id,
      user_id: currentUser._id,
      home_id: shift.home_id,
      scheduled_end: scheduledEnd,
      actual_clock_out: assignment.clock_out_time,
      requested_minutes: minutes,
      reason,
    });

    await overtime.save();
    res.status(201).json(overtime);
  } catch (error) {
    console.error('Error creating overtime request:', error);
    if (error.code === 11000) {
      return res.status(409).json({ error: 'An overtime request already exists for this shift' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation failed',
        details: Object.values(error.errors).map((e) => e.message)
      });
    }
    res.status(500).json({ error: 'Failed to create overtime request' });
  }
});

// Approve an overtime request (admin only).
router.post('/:id/approve', requireRole(['admin']), async (req, res) => {
  try {
    const overtime = await OvertimeRequest.findById(req.params.id);
    if (!overtime) {
      return res.status(404).json({ error: 'Overtime request not found' });
    }
    overtime.approve(req.user._id);
    await overtime.save();
    res.json(overtime);
  } catch (error) {
    if (error.message && error.message.includes('pending')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error approving overtime request:', error);
    res.status(500).json({ error: 'Failed to approve overtime request' });
  }
});

// Deny an overtime request (admin only — overtime decisions are admin-controlled).
router.post('/:id/deny', requireRole(['admin']), async (req, res) => {
  try {
    const overtime = await OvertimeRequest.findById(req.params.id);
    if (!overtime) {
      return res.status(404).json({ error: 'Overtime request not found' });
    }
    overtime.deny(req.user._id, req.body.denial_reason);
    await overtime.save();
    res.json(overtime);
  } catch (error) {
    if (error.message && error.message.includes('pending')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error denying overtime request:', error);
    res.status(500).json({ error: 'Failed to deny overtime request' });
  }
});

module.exports = router;
