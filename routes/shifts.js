const express = require('express');
const router = express.Router();

const CAP_CONFLICT = 'fulltime_weekly_cap_exceeded';
// Rule breaks a staff member's own shift selection may go ahead with, pending review.
const SELF_SELECT_REVIEWABLE = new Set(['insufficient_rest', CAP_CONFLICT]);
const Shift = require('../models/Shift');
const ServiceUser = require('../models/ServiceUser');
const User = require('../models/User');
const SolverSettings = require('../models/SolverSettings');
const { notifyAdminsHoursCapRequested } = require('../services/attendanceNotifications');
const { requireRole } = require('../middleware/auth');
const {
  shiftStartDate,
  shiftEndDate,
  EARLY_CLOCK_IN_MINUTES,
  OVERTIME_ELIGIBLE_MINUTES,
  LATE_ARRIVAL_MINUTES,
} = require('../utils/shiftTime');
const {
  isOneToOne,
  isCoveredByBackground,
} = require('../utils/oneToOne');

// Resolve the target staff member for a clock action: support workers may only act on
// themselves; managers/admins/senior staff may pass a user_id to act on someone's behalf.
function resolveClockTarget(req) {
  const currentUser = req.user;
  const allowedRoles = ['admin', 'key_worker', 'senior_staff'];
  const requestedId = req.body && req.body.user_id ? String(req.body.user_id) : null;

  if (requestedId && requestedId !== currentUser._id.toString()) {
    if (!allowedRoles.includes(currentUser.role)) {
      return { error: 'Insufficient permissions. You can only clock in/out for yourself.' };
    }
    return { userId: requestedId };
  }
  return { userId: currentUser._id.toString() };
}

// Get all shifts
router.get('/', async (req, res) => {
  try {
    const { home_id, service_id, service_user_id, kind, date, start_date, end_date, user_id } = req.query;
    const filter = {};
    
    // Validate home_id if provided
    if (home_id && home_id !== 'undefined' && home_id !== 'null') {
      filter.home_id = home_id;
    }
    if (service_id && service_id !== 'undefined' && service_id !== 'null') {
      filter.service_id = service_id;
    }
    if (service_user_id && service_user_id !== 'undefined' && service_user_id !== 'null') {
      filter.service_user_id = service_user_id;
    }
    if (kind === 'one_to_one') filter.shift_type = 'one_to_one';
    if (kind === 'background') filter.shift_type = { $ne: 'one_to_one' };
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
    
    const shifts = await Shift.find(filter)
      .populate('service_id', 'name')
      .populate('service_user_id', 'name');
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// Get available shifts for staff selection
router.get('/available', async (req, res) => {
  try {
    const { user_id, start_date, end_date, home_ids } = req.query;
    
    if (!user_id || !start_date || !end_date) {
      return res.status(400).json({ 
        error: 'Missing required parameters: user_id, start_date, end_date' 
      });
    }

    // Get user's homes if home_ids not provided
    let targetHomeIds = [];
    if (home_ids) {
      targetHomeIds = home_ids.split(',').filter(id => id && id !== 'undefined' && id !== 'null');
    } else {
      const User = require('../models/User');
      const user = await User.findById(user_id).select('homes');
      if (user && user.homes) {
        targetHomeIds = user.homes.map(home => home.home_id.toString());
      }
    }

    if (targetHomeIds.length === 0) {
      return res.json([]);
    }

    // Get shifts that need more staff in user's homes
    const shifts = await Shift.find({
      home_id: { $in: targetHomeIds },
      date: { $gte: start_date, $lte: end_date },
      is_active: true
    }).populate('service_id', 'name').populate('home_id', 'name');

    // Filter to shifts that need more staff and user isn't already assigned to.
    // 1-to-1 shifts are admin-assigned, never offered for self-selection.
    const availableShifts = shifts.filter(shift => {
      if (isOneToOne(shift)) return false;
      const currentAssignments = shift.assigned_staff || [];
      const requiredStaff = shift.required_staff_count || 1;
      
      // Check if shift needs more staff
      if (currentAssignments.length >= requiredStaff) return false;
      
      // Check if user is already assigned to this shift
      const isAlreadyAssigned = currentAssignments.some(assignment => 
        assignment.user_id.toString() === user_id
      );
      
      return !isAlreadyAssigned;
    });

    res.json(availableShifts);
  } catch (error) {
    console.error('Error fetching available shifts:', error);
    res.status(500).json({ error: 'Failed to fetch available shifts' });
  }
});

// Get clock-in / clock-out logs across all staff (admin analysis page).
// Flattens each assigned staff member's attendance into one log row per shift.
router.get(
  '/attendance/logs',
  requireRole(['admin']),
  async (req, res) => {
    try {
      const { home_id, start_date, end_date, status } = req.query;
      const filter = { is_active: true };

      if (home_id && home_id !== 'undefined' && home_id !== 'null') {
        filter.home_id = home_id;
      }
      if (start_date || end_date) {
        filter.date = {};
        if (start_date) filter.date.$gte = start_date;
        if (end_date) filter.date.$lte = end_date;
      }

      const shifts = await Shift.find(filter)
        .populate('home_id', 'name')
        .populate('service_id', 'name')
        .populate('assigned_staff.user_id', 'name email role')
        .sort({ date: -1, start_time: -1 });

      const logs = [];
      for (const shift of shifts) {
        const scheduledStart = shiftStartDate(shift);
        const scheduledEnd = shiftEndDate(shift);

        for (const a of shift.assigned_staff || []) {
          if (a.status === 'declined') continue;

          // Skip staff who were never scheduled to a real attendance state.
          const attendanceStatus = a.attendance_status || 'not_started';
          if (status && status !== 'all' && attendanceStatus !== status) continue;

          const clockIn = a.clock_in_time ? new Date(a.clock_in_time) : null;
          const clockOut = a.clock_out_time ? new Date(a.clock_out_time) : null;

          // Minutes late = clock-in past scheduled start (0 if early / on time / absent).
          const minutesLate = clockIn
            ? Math.max(0, Math.round((clockIn.getTime() - scheduledStart.getTime()) / 60000))
            : 0;
          // Minutes over = clock-out past scheduled end (0 if on time / early).
          const minutesOver = clockOut
            ? Math.max(0, Math.round((clockOut.getTime() - scheduledEnd.getTime()) / 60000))
            : 0;
          const workedMinutes =
            clockIn && clockOut
              ? Math.max(0, Math.round((clockOut.getTime() - clockIn.getTime()) / 60000))
              : null;
          const scheduledMinutes = Math.max(
            0,
            Math.round((scheduledEnd.getTime() - scheduledStart.getTime()) / 60000)
          );

          const user = a.user_id && typeof a.user_id === 'object' ? a.user_id : null;

          logs.push({
            shift_id: shift._id,
            user_id: user ? user._id : a.user_id,
            user_name: user ? user.name : 'Unknown',
            user_email: user ? user.email : null,
            user_role: user ? user.role : null,
            home_name:
              shift.home_id && typeof shift.home_id === 'object' ? shift.home_id.name : null,
            service_name:
              shift.service_id && typeof shift.service_id === 'object'
                ? shift.service_id.name
                : null,
            date: shift.date,
            start_time: shift.start_time,
            end_time: shift.end_time,
            shift_type: shift.shift_type,
            scheduled_start: scheduledStart.toISOString(),
            scheduled_end: scheduledEnd.toISOString(),
            scheduled_minutes: scheduledMinutes,
            attendance_status: attendanceStatus,
            clock_in_time: clockIn ? clockIn.toISOString() : null,
            clock_out_time: clockOut ? clockOut.toISOString() : null,
            worked_minutes: workedMinutes,
            minutes_late: minutesLate,
            minutes_over: minutesOver,
            is_late: minutesLate >= LATE_ARRIVAL_MINUTES,
          });
        }
      }

      // Summary counts for the dashboard cards.
      const summary = {
        total: logs.length,
        clocked_in: logs.filter((l) => l.attendance_status === 'clocked_in').length,
        clocked_out: logs.filter((l) => l.attendance_status === 'clocked_out').length,
        not_started: logs.filter((l) => l.attendance_status === 'not_started').length,
        missed: logs.filter((l) => l.attendance_status === 'missed').length,
        late: logs.filter((l) => l.is_late).length,
      };

      res.json({ logs, summary });
    } catch (error) {
      console.error('Error fetching attendance logs:', error);
      res.status(500).json({ error: 'Failed to fetch attendance logs' });
    }
  }
);

// Flagged assignments awaiting review, flattened to one row per flagged staff member.
// `field` is the assignment status field (rest_exception_status / hours_cap_exception_status).
async function listFlaggedAssignments(field, status, homeId) {
  const filter = { [`assigned_staff.${field}`]: status };
  if (homeId) filter.home_id = homeId;

  const shifts = await Shift.find(filter)
    .populate('assigned_staff.user_id', 'name email role')
    .populate('service_id', 'name')
    .sort({ date: 1, start_time: 1 });

  const rows = [];
  for (const shift of shifts) {
    for (const a of shift.assigned_staff) {
      if (a[field] !== status) continue;
      rows.push({
        shift_id: shift._id,
        user: a.user_id,
        date: shift.date,
        start_time: shift.start_time,
        end_time: shift.end_time,
        shift_type: shift.shift_type,
        home_id: shift.home_id,
        service: shift.service_id,
        [field]: a[field],
        ...(field === 'hours_cap_exception_status' ? { projected_weekly_hours: a.hours_cap_exception_hours } : {}),
        assigned_at: a.assigned_at
      });
    }
  }
  return rows;
}

// List rest-exception assignments for admin review. Defaults to pending. Registered before
// `/:id` so the literal path is matched first.
router.get('/rest-exceptions', requireRole(['admin', 'key_worker']), async (req, res) => {
  try {
    res.json(await listFlaggedAssignments('rest_exception_status', req.query.status || 'pending', req.query.home_id));
  } catch (error) {
    console.error('Error listing rest exceptions:', error);
    res.status(500).json({ error: 'Failed to fetch rest exceptions' });
  }
});

// Only the cap approver roles (SolverSettings.manual_assign_cap, default admin) review
// full-time weekly-cap requests.
async function requireCapApprover(req, res, next) {
  try {
    const { manual_assign_cap } = await SolverSettings.getSettings();
    if (!manual_assign_cap.approver_roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only ' + manual_assign_cap.approver_roles.join(' or ') + ' can review weekly hours requests' });
    }
    next();
  } catch (error) {
    console.error('Error checking hours-cap approver:', error);
    res.status(500).json({ error: 'Failed to check permissions' });
  }
}

// List full-time weekly-cap requests (self-selected shifts over the cap). Defaults to pending.
router.get('/hours-cap-exceptions', requireCapApprover, async (req, res) => {
  try {
    res.json(await listFlaggedAssignments('hours_cap_exception_status', req.query.status || 'pending', req.query.home_id));
  } catch (error) {
    console.error('Error listing hours-cap exceptions:', error);
    res.status(500).json({ error: 'Failed to fetch weekly hours requests' });
  }
});

// Get shift by ID
router.get('/:id', async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id)
      .populate('service_id', 'name')
      .populate('service_user_id', 'name');
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    res.json(shift);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch shift' });
  }
});

// Fields a client may set on create/update. Everything else (assigned_staff, attendance)
// is managed by dedicated endpoints.
const EDITABLE_SHIFT_FIELDS = [
  'home_id',
  'service_id',
  'service_user_id',
  'date',
  'start_time',
  'end_time',
  'shift_type',
  'required_staff_count',
  'is_urgent',
  'notes',
  'is_active',
];

function pickShiftFields(body) {
  const data = {};
  for (const key of EDITABLE_SHIFT_FIELDS) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  // An empty picker value means "no service user"; a populated object sends its id.
  if (data.service_user_id === '') data.service_user_id = null;
  if (data.service_user_id && typeof data.service_user_id === 'object') {
    data.service_user_id = data.service_user_id._id || data.service_user_id.id || null;
  }
  return data;
}

// Validate 1-to-1 rules for the merged (existing + incoming) shift data. Returns an
// { status, error, details } object to send, or null when valid.
async function checkOneToOneRules(req, merged, existing) {
  const touchesOneToOne = isOneToOne(merged.shift_type) || (existing && isOneToOne(existing));
  if (!touchesOneToOne) return null;
  if (req.user.role !== 'admin') {
    return { status: 403, error: 'Only admins can create or edit 1-to-1 shifts' };
  }
  if (!isOneToOne(merged.shift_type)) return null;
  if (!merged.service_user_id) {
    return { status: 400, error: 'Validation failed', details: ['A 1-to-1 shift must be linked to a service user'] };
  }
  const serviceUser = await ServiceUser.findById(merged.service_user_id).select('home_id is_active');
  if (!serviceUser || serviceUser.is_active === false) {
    return { status: 400, error: 'Validation failed', details: ['Service user not found or inactive'] };
  }
  if (String(serviceUser.home_id) !== String(merged.home_id)) {
    return { status: 400, error: 'Validation failed', details: ["The service user does not belong to this shift's home"] };
  }
  return null;
}

function sendShiftSaveError(res, error, fallback) {
  if (error.name === 'ValidationError') {
    const validationErrors = Object.values(error.errors).map(err => err.message);
    return res.status(400).json({ error: 'Validation failed', details: validationErrors });
  }
  if (error.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid data format', details: error.message });
  }
  return res.status(400).json({ error: fallback });
}

// Create new shift
router.post('/', requireRole(['admin', 'key_worker', 'senior_staff']), async (req, res) => {
  try {
    const data = pickShiftFields(req.body);
    if (isOneToOne(data.shift_type) && data.required_staff_count === undefined) {
      data.required_staff_count = 1;
    }

    // Validate that the service exists
    const Service = require('../models/Service');
    const service = await Service.findById(data.service_id);
    if (!service) {
      return res.status(400).json({ 
        error: 'Service not found', 
        details: ['The specified service does not exist'] 
      });
    }

    const ruleError = await checkOneToOneRules(req, data, null);
    if (ruleError) {
      const { status, ...body } = ruleError;
      return res.status(status).json(body);
    }

    // Background shifts at the same home may overlap (e.g. 08:00-20:00 alongside
    // 10:00-18:00); staff double-booking is checked when staff are assigned.

    const shift = new Shift(data);
    await shift.save();
    res.status(201).json(shift);
  } catch (error) {
    console.error('❌ Error creating shift:', error);
    sendShiftSaveError(res, error, 'Failed to create shift');
  }
});

// Update shift
router.put('/:id', requireRole(['admin', 'key_worker', 'senior_staff']), async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const data = pickShiftFields(req.body);
    const merged = { ...shift.toObject(), ...data };

    const ruleError = await checkOneToOneRules(req, merged, shift);
    if (ruleError) {
      const { status, ...body } = ruleError;
      return res.status(status).json(body);
    }
    // Leaving the 1-to-1 type drops the service-user link.
    if (!isOneToOne(merged.shift_type)) data.service_user_id = null;

    shift.set(data);
    await shift.save();
    res.json(shift);
  } catch (error) {
    console.error('❌ Error updating shift:', error);
    sendShiftSaveError(res, error, 'Failed to update shift');
  }
});

// Delete shift
router.delete('/:id', requireRole(['admin', 'key_worker', 'senior_staff']), async (req, res) => {
  try {
    const existing = await Shift.findById(req.params.id).select('shift_type');
    if (!existing) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    if (isOneToOne(existing) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can delete 1-to-1 shifts' });
    }
    await Shift.findByIdAndDelete(req.params.id);
    res.json({ message: 'Shift deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

/**
 * Decide what assigning `userId` to `shift` would do, without changing anything. Shared by
 * the assign route and the self-select preview so both apply exactly the same rules.
 * Returns `{ error: { status, body } }` when it is refused, otherwise the review flags:
 * `{ restExceptionPending, capExceptionStatus, capExceptionHours, pendingReasons }`.
 *
 * Admins may override any rule (time-off / >24h day / rest / weekly cap) after confirming;
 * the cap approver roles (SolverSettings.manual_assign_cap, default admin) may confirm the
 * weekly cap. Staff selecting a shift for themselves that only breaks the rest rule and/or
 * the weekly cap get it held for them, pending review. Overlap is never overridable.
 */
async function evaluateAssignment({ shift, userId, currentUser, override, capPolicy }) {
  const isSelfAssign = currentUser._id.toString() === userId;
  const isCapApprover = capPolicy.approver_roles.includes(currentUser.role);
  const canOverrideType = (type) =>
    currentUser.role === 'admin' || (type === CAP_CONFLICT && isCapApprover);

  const SchedulingConflictService = require('../services/schedulingConflictService');
  const conflictCheck = await SchedulingConflictService.checkShiftAssignmentConflict(
    userId,
    shift.date,
    shift.start_time,
    shift.end_time,
    {
      shiftType: shift.shift_type,
      shiftId: shift._id,
      homeId: shift.home_id
    }
  );

  const decision = { restExceptionPending: false, capExceptionStatus: 'none', capExceptionHours: null, pendingReasons: [] };

  if (conflictCheck.hasConflict) {
    const friendlyFor = (check) => {
      switch (check.conflictType) {
        case 'time_off':
          return `Cannot assign staff member to shift on ${check.conflicts[0]?.start_date || 'this date'} - they have approved time off`;
        case 'overlapping_shift':
          return `Cannot assign staff member - they already have overlapping shifts on ${check.conflicts[0]?.date || 'this date'}`;
        case 'max_hours_exceeded':
          return `Cannot assign staff member - this would exceed maximum daily hours (${check.message})`;
        default:
          return check.message;
      }
    };

    // Same-time double-booking is a hard block for everyone (never overridable).
    if (conflictCheck.conflictType === 'overlapping_shift') {
      const msg = friendlyFor(conflictCheck);
      return {
        error: {
          status: 409,
          body: { error: 'Scheduling conflict detected', conflict: conflictCheck, overridable: false, message: msg, userFriendlyMessage: msg }
        }
      };
    }

    const overridableConflicts = conflictCheck.overridableConflicts || [];
    const conflictTypes = overridableConflicts.map((c) => c.conflictType);
    const canOverrideAll = conflictTypes.length > 0 && conflictTypes.every(canOverrideType);
    const reviewable = conflictTypes.length > 0 && conflictTypes.every((t) => SELF_SELECT_REVIEWABLE.has(t));
    const capConflict = overridableConflicts.find((c) => c.conflictType === CAP_CONFLICT);
    const capHours = capConflict?.details?.projected_weekly_hours ?? null;

    if (override && canOverrideAll) {
      // Confirmed by an approver: record that the cap was knowingly exceeded.
      if (capConflict) {
        decision.capExceptionStatus = 'confirmed';
        decision.capExceptionHours = capHours;
      }
    } else if (isSelfAssign && !canOverrideAll && reviewable) {
      decision.restExceptionPending = conflictTypes.includes('insufficient_rest');
      if (capConflict) {
        decision.capExceptionStatus = 'pending';
        decision.capExceptionHours = capHours;
      }
      decision.pendingReasons = overridableConflicts.map((c) => c.message);
    } else {
      const msg = friendlyFor(conflictCheck);
      return {
        error: {
          status: 409,
          body: {
            error: 'Scheduling conflict detected',
            conflict: conflictCheck,
            overridable: canOverrideAll,
            overridableConflicts,
            message: msg,
            userFriendlyMessage: msg
          }
        }
      };
    }
  }

  if (shift.assigned_staff.length >= shift.required_staff_count) {
    return {
      error: {
        status: 400,
        body: {
          error: 'Shift is already fully staffed',
          message: `This shift requires ${shift.required_staff_count} staff members and already has ${shift.assigned_staff.length} assigned`
        }
      }
    };
  }

  if (shift.assigned_staff.some((assignment) => assignment.user_id.toString() === userId)) {
    return {
      error: {
        status: 400,
        body: { error: 'Staff member already assigned', message: 'This staff member is already assigned to this shift' }
      }
    };
  }

  return decision;
}

// Preview selecting shifts for yourself: for each shift id, whether it would be assigned
// straight away ('ok'), held pending admin approval ('pending', with reasons) or refused
// ('blocked', with the reason). Uses the same rules as POST /:id/assign.
router.post('/assign-preview', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.shift_ids) ? req.body.shift_ids.slice(0, 200) : [];
    const { manual_assign_cap: capPolicy } = await SolverSettings.getSettings();
    const shifts = await Shift.find({ _id: { $in: ids } });
    const userId = req.user._id.toString();

    const results = {};
    for (const shift of shifts) {
      if (isOneToOne(shift) && req.user.role !== 'admin') {
        results[shift._id] = { outcome: 'blocked', message: 'Only admins can assign staff to 1-to-1 shifts' };
        continue;
      }
      const decision = await evaluateAssignment({ shift, userId, currentUser: req.user, override: false, capPolicy });
      if (decision.error) {
        results[shift._id] = { outcome: 'blocked', message: decision.error.body.message || decision.error.body.error };
      } else if (decision.pendingReasons.length > 0) {
        results[shift._id] = { outcome: 'pending', reasons: decision.pendingReasons };
      } else {
        results[shift._id] = { outcome: 'ok' };
      }
    }
    res.json(results);
  } catch (error) {
    console.error('Error previewing shift selection:', error);
    res.status(500).json({ error: 'Failed to check shifts' });
  }
});

// Assign staff to shift
router.post('/:id/assign', async (req, res) => {
  try {
    const { user_id, note, override } = req.body;
    const shift = await Shift.findById(req.params.id);

    // Check permissions: admins/managers/senior staff can assign anyone, support workers can only assign themselves
    const currentUser = req.user; // This should be set by the authenticateToken middleware
    const allowedRoles = ['admin', 'key_worker', 'senior_staff'];
    const isSelfAssign = currentUser._id.toString() === String(user_id);
    // Admins may override any rule (time-off / >24h day / rest / weekly cap) after confirming.
    // Approver roles in SolverSettings.manual_assign_cap (default admin only) may also confirm
    // the full-time weekly cap. Overlap is never overridable.
    const { manual_assign_cap: capPolicy } = await SolverSettings.getSettings();

    if (!allowedRoles.includes(currentUser.role) && !isSelfAssign) {
      return res.status(403).json({
        error: 'Insufficient permissions. You can only assign yourself to shifts.',
        message: 'Support workers can only select shifts for themselves'
      });
    }

    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    // 1-to-1 shifts are assigned by admins only (no self-selection).
    if (isOneToOne(shift) && currentUser.role !== 'admin') {
      return res.status(403).json({
        error: 'Only admins can assign staff to 1-to-1 shifts',
        message: 'Only admins can assign staff to 1-to-1 shifts'
      });
    }

    const decision = await evaluateAssignment({ shift, userId: String(user_id), currentUser, override, capPolicy });
    if (decision.error) {
      return res.status(decision.error.status).json(decision.error.body);
    }
    const { restExceptionPending, capExceptionStatus, capExceptionHours } = decision;

    shift.assignStaff(user_id, note, {
      rest_exception_status: restExceptionPending ? 'pending' : 'none',
      hours_cap_exception_status: capExceptionStatus,
      hours_cap_exception_hours: capExceptionHours
    });
    await shift.save();

    if (capExceptionStatus === 'pending') {
      const staffUser = await User.findById(user_id).select('name email role');
      notifyAdminsHoursCapRequested(shift, staffUser, capExceptionHours, capPolicy.fulltime_hours)
        .catch((error) => console.error('Failed to notify admins of hours-cap request:', error));
    }

    const payload = shift.toObject({ virtuals: true });
    payload.rest_exception_pending = restExceptionPending;
    payload.hours_cap_exception_pending = capExceptionStatus === 'pending';
    if (isOneToOne(shift)) {
      payload.covered_by_background = await isCoveredByBackground(shift, user_id);
    }
    res.json(payload);
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

// Approve a flagged assignment: set `field` to 'confirmed' and keep the staff member on it.
async function confirmFlagged(field, req, res) {
  const shift = await Shift.findById(req.params.id);
  if (!shift) {
    return res.status(404).json({ error: 'Shift not found' });
  }
  const assignment = shift.assigned_staff.find(
    (a) => a.user_id.toString() === String(req.params.userId)
  );
  if (!assignment) {
    return res.status(404).json({ error: 'Staff member is not assigned to this shift' });
  }
  assignment[field] = 'confirmed';
  await shift.save();
  res.json(shift);
}

// Reject a flagged assignment: un-assign the staff member.
async function removeFlagged(req, res) {
  const shift = await Shift.findById(req.params.id);
  if (!shift) {
    return res.status(404).json({ error: 'Shift not found' });
  }
  if (isOneToOne(shift) && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can unassign staff from 1-to-1 shifts' });
  }
  try {
    shift.removeStaff(req.params.userId);
  } catch (error) {
    if (error.message && error.message.includes('not assigned')) {
      return res.status(404).json({ error: error.message });
    }
    throw error;
  }
  await shift.save();
  res.json(shift);
}

// Confirm a pending rest-exception: the admin accepts the reduced rest gap and clears the flag.
router.post('/:id/rest-exception/:userId/confirm', requireRole(['admin', 'key_worker']), async (req, res) => {
  try {
    await confirmFlagged('rest_exception_status', req, res);
  } catch (error) {
    console.error('Error confirming rest exception:', error);
    res.status(500).json({ error: 'Failed to confirm rest exception' });
  }
});

// Remove a rest-exception assignment: the admin rejects it and un-assigns the staff member.
router.post('/:id/rest-exception/:userId/remove', requireRole(['admin', 'key_worker']), async (req, res) => {
  try {
    await removeFlagged(req, res);
  } catch (error) {
    console.error('Error removing rest exception:', error);
    res.status(500).json({ error: 'Failed to remove rest exception' });
  }
});

// Approve a weekly-hours request: the staff member keeps the shift above the full-time cap.
router.post('/:id/hours-cap-exception/:userId/confirm', requireCapApprover, async (req, res) => {
  try {
    await confirmFlagged('hours_cap_exception_status', req, res);
  } catch (error) {
    console.error('Error confirming hours-cap exception:', error);
    res.status(500).json({ error: 'Failed to approve weekly hours request' });
  }
});

// Decline a weekly-hours request: un-assign the staff member.
router.post('/:id/hours-cap-exception/:userId/remove', requireCapApprover, async (req, res) => {
  try {
    await removeFlagged(req, res);
  } catch (error) {
    console.error('Error removing hours-cap exception:', error);
    res.status(500).json({ error: 'Failed to decline weekly hours request' });
  }
});

// Clock in to a shift
router.post('/:id/clock-in', async (req, res) => {
  try {
    const target = resolveClockTarget(req);
    if (target.error) {
      return res.status(403).json({ error: target.error });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const assignment = shift.assigned_staff.find(
      (a) => a.user_id.toString() === target.userId && a.status !== 'declined'
    );
    if (!assignment) {
      return res.status(403).json({
        error: 'Not assigned to this shift',
        message: 'You can only clock in to shifts you are assigned to.'
      });
    }

    if (assignment.clock_in_time) {
      return res.status(400).json({ error: 'Already clocked in to this shift' });
    }

    if (Shift.isAwaitingApproval(assignment)) {
      return res.status(409).json({
        error: 'This shift is awaiting admin approval',
        message: 'You can clock in once an admin approves this shift.',
        pending_approval: true
      });
    }

    // A 1-to-1 inside the staff member's own background shift inherits that shift's
    // attendance, so there is nothing to clock in to.
    if (isOneToOne(shift) && (await isCoveredByBackground(shift, target.userId))) {
      return res.status(409).json({
        error: 'Covered by your background shift — no clock-in needed',
        covered_by_background: true
      });
    }

    // Time-window gate: from EARLY_CLOCK_IN_MINUTES before start up to scheduled end.
    const now = new Date();
    const start = shiftStartDate(shift);
    const end = shiftEndDate(shift);
    const windowOpen = new Date(start.getTime() - EARLY_CLOCK_IN_MINUTES * 60000);
    if (now < windowOpen) {
      return res.status(400).json({
        error: 'Too early to clock in',
        message: `Clock-in opens at ${windowOpen.toISOString()}`
      });
    }
    if (now > end) {
      return res.status(400).json({
        error: 'Shift has already ended',
        message: 'Clock-in is no longer available for this shift.'
      });
    }

    assignment.clock_in_time = now;
    assignment.attendance_status = 'clocked_in';
    await shift.save();

    res.json(shift);
  } catch (error) {
    console.error('Error clocking in:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid data format', details: error.message });
    }
    res.status(500).json({ error: 'Internal server error', message: 'Failed to clock in' });
  }
});

// Clock out of a shift
router.post('/:id/clock-out', async (req, res) => {
  try {
    const target = resolveClockTarget(req);
    if (target.error) {
      return res.status(403).json({ error: target.error });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const assignment = shift.assigned_staff.find(
      (a) => a.user_id.toString() === target.userId && a.status !== 'declined'
    );
    if (!assignment) {
      return res.status(403).json({
        error: 'Not assigned to this shift',
        message: 'You can only clock out of shifts you are assigned to.'
      });
    }

    if (!assignment.clock_in_time) {
      return res.status(400).json({ error: 'You must clock in before clocking out' });
    }
    if (assignment.clock_out_time) {
      return res.status(400).json({ error: 'Already clocked out of this shift' });
    }

    const now = new Date();
    if (now <= assignment.clock_in_time) {
      return res.status(400).json({ error: 'Clock-out time must be after clock-in time' });
    }

    assignment.clock_out_time = now;
    assignment.attendance_status = 'clocked_out';
    await shift.save();

    // Flag overtime eligibility if clocked out well past scheduled end.
    const scheduledEnd = shiftEndDate(shift);
    const extraMinutes = Math.round((now.getTime() - scheduledEnd.getTime()) / 60000);
    const overtimeEligible = extraMinutes > OVERTIME_ELIGIBLE_MINUTES;

    res.json({
      shift,
      overtime_eligible: overtimeEligible,
      extra_minutes: overtimeEligible ? extraMinutes : 0,
      scheduled_end: scheduledEnd.toISOString(),
    });
  } catch (error) {
    console.error('Error clocking out:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid data format', details: error.message });
    }
    res.status(500).json({ error: 'Internal server error', message: 'Failed to clock out' });
  }
});

// Remove staff from shift
router.delete('/:id/assign/:userId', requireRole(['admin', 'key_worker', 'senior_staff']), async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    
    if (!shift) {
      return res.status(404).json({ error: 'Shift not found' });
    }
    
    if (isOneToOne(shift) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can unassign staff from 1-to-1 shifts' });
    }

    shift.removeStaff(req.params.userId);
    await shift.save();
    
    res.json(shift);
  } catch (error) {
    res.status(400).json({ error: 'Failed to remove staff' });
  }
});

// Check for scheduling conflicts
router.get('/conflicts/check', requireRole(['admin', 'key_worker', 'senior_staff']), async (req, res) => {
  try {
    const { home_id, start_date, end_date } = req.query;
    
    const mongoose = require('mongoose');
    if (!home_id || home_id === 'null' || home_id === 'undefined') {
      return res.status(400).json({ error: 'Valid home_id is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(home_id)) {
      return res.status(400).json({ error: 'Invalid home_id' });
    }

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
