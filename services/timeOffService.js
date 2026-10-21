const User = require('../models/User');
const Timetable = require('../models/Timetable');
const Shift = require('../models/Shift');
const Availability = require('../models/Availability');
const Home = require('../models/Home');
const TimeOffRequest = require('../models/TimeOffRequest');
const SolverSettings = require('../models/SolverSettings');

const LOCKED_TIMETABLE_STATUSES = ['generated', 'published'];

// Unplanned leave can't reasonably be refused, so these types skip the limit check
// (they still count towards the number of staff away).
const HOME_LEAVE_LIMIT_EXEMPT_TYPES = ['sick_leave', 'bereavement'];

const REQUEST_TYPE_LABELS = {
  annual_leave: 'Annual leave',
  sick_leave: 'Sick leave',
  personal_leave: 'Personal leave',
  bereavement: 'Bereavement',
  other: 'Other'
};

function eachDateInRange(startDateStr, endDateStr) {
  const dates = [];
  const current = new Date(`${startDateStr}T12:00:00`);
  const end = new Date(`${endDateStr}T12:00:00`);
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function getUserHomeIdStrings(userId) {
  const user = await User.findById(userId).select('homes');
  if (!user?.homes?.length) return [];
  return user.homes.map((h) => h.home_id.toString());
}

function userAssignedOnTimetableInRange(timetable, userIdStr, startDate, endDate) {
  for (const week of timetable.weekly_rotas || []) {
    for (const shift of week.shifts || []) {
      if (shift.date >= startDate && shift.date <= endDate) {
        const assigned = shift.assigned_staff || [];
        if (assigned.some((a) => a.user_id?.toString() === userIdStr)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Returns conflict info if the user is scheduled on a generated/published timetable
 * or live shifts during the requested leave period.
 */
async function findTimetableConflictForLeave(userId, startDate, endDate) {
  const homeIds = await getUserHomeIdStrings(userId);
  if (!homeIds.length) return null;

  const userIdStr = userId.toString();
  const rangeStart = new Date(`${startDate}T00:00:00`);
  const rangeEnd = new Date(`${endDate}T23:59:59`);

  const timetables = await Timetable.find({
    status: { $in: LOCKED_TIMETABLE_STATUSES },
    home_ids: { $in: homeIds },
    start_date: { $lte: rangeEnd },
    end_date: { $gte: rangeStart }
  }).select('name status weekly_rotas');

  for (const timetable of timetables) {
    if (userAssignedOnTimetableInRange(timetable, userIdStr, startDate, endDate)) {
      return {
        source: 'timetable',
        name: timetable.name,
        status: timetable.status
      };
    }
  }

  const liveShift = await Shift.findOne({
    date: { $gte: startDate, $lte: endDate },
    home_id: { $in: homeIds },
    'assigned_staff.user_id': userId
  }).select('date home_id');

  if (liveShift) {
    return {
      source: 'shift',
      name: 'published rota'
    };
  }

  return null;
}

function buildAutoDenialReason(conflict) {
  if (conflict.source === 'timetable') {
    return `Automatically rejected: you are scheduled on the generated timetable "${conflict.name}" during these dates. Contact your manager to adjust the rota before requesting leave.`;
  }
  return 'Automatically rejected: you are already assigned to shifts on a published schedule during these dates. Contact your manager before requesting leave.';
}

/**
 * Soft limit: returns the busiest day on which granting this leave would put more than
 * the admin-set number of staff (SolverSettings.leave_limit.max_staff_per_home) from one
 * of the user's homes on approved leave, or null if the request stays within the limit
 * (or its type is exempt). Going over it needs an admin's explicit override.
 */
async function findHomeLeaveLimitConflict(userId, startDate, endDate, requestType, excludeRequestId = null) {
  if (HOME_LEAVE_LIMIT_EXEMPT_TYPES.includes(requestType)) return null;

  const homeIds = await getUserHomeIdStrings(userId);
  if (!homeIds.length) return null;

  const { leave_limit: { max_staff_per_home: limit } } = await SolverSettings.getSettings();

  const userIdStr = userId.toString();
  const query = {
    status: 'approved',
    user_id: { $ne: userId },
    start_date: { $lte: endDate },
    end_date: { $gte: startDate }
  };
  if (excludeRequestId) query._id = { $ne: excludeRequestId };

  const overlapping = await TimeOffRequest.find(query).populate('user_id', 'name homes is_active');

  // home id -> date -> Map(user id -> name)
  const onLeave = new Map(homeIds.map((h) => [h, new Map()]));
  for (const leave of overlapping) {
    const colleague = leave.user_id;
    if (!colleague || colleague.is_active === false || colleague._id.toString() === userIdStr) continue;
    const sharedHomes = (colleague.homes || [])
      .map((h) => h.home_id.toString())
      .filter((h) => onLeave.has(h));
    if (!sharedHomes.length) continue;

    const from = leave.start_date > startDate ? leave.start_date : startDate;
    const to = leave.end_date < endDate ? leave.end_date : endDate;
    for (const date of eachDateInRange(from, to)) {
      for (const homeId of sharedHomes) {
        const byDate = onLeave.get(homeId);
        if (!byDate.has(date)) byDate.set(date, new Map());
        byDate.get(date).set(colleague._id.toString(), colleague.name);
      }
    }
  }

  let worst = null;
  for (const [homeId, byDate] of onLeave) {
    for (const [date, staff] of byDate) {
      if (staff.size >= limit && (!worst || staff.size > worst.staff.size)) {
        worst = { homeId, date, staff };
      }
    }
  }
  if (!worst) return null;

  const home = await Home.findById(worst.homeId).select('name');
  return {
    home_id: worst.homeId,
    home_name: home?.name || 'this home',
    date: worst.date,
    staff_on_leave: [...worst.staff.values()],
    limit
  };
}

function buildHomeLeaveLimitMessage(conflict) {
  return `${conflict.staff_on_leave.length} staff from ${conflict.home_name} already have approved leave on ${conflict.date} (${conflict.staff_on_leave.join(', ')}). No more than ${conflict.limit} staff from one home may be on leave at the same time without admin permission.`;
}

/**
 * Upsert daily availability as unavailable for each day of approved leave.
 */
const APPROVED_LEAVE_NOTE_PREFIX = 'Approved leave: ';

async function syncAvailabilityForApprovedLeave(timeOffRequest) {
  const userId = timeOffRequest.user_id;
  const typeLabel = REQUEST_TYPE_LABELS[timeOffRequest.request_type] || timeOffRequest.request_type;
  const note = `${APPROVED_LEAVE_NOTE_PREFIX}${typeLabel}`;
  const dates = eachDateInRange(timeOffRequest.start_date, timeOffRequest.end_date);

  for (const dateStr of dates) {
    await Availability.findOneAndUpdate(
      { user_id: userId, date: dateStr },
      {
        user_id: userId,
        date: dateStr,
        start_time: '00:00',
        end_time: '23:59',
        is_available: false,
        preferred_shift_type: 'none',
        notes: note
      },
      { upsert: true, new: true, runValidators: true }
    );
  }
}

/**
 * Undoes syncAvailabilityForApprovedLeave when approved leave is cancelled: removes the
 * "Approved leave" unavailable entries so those days are free again. Days still covered
 * by the user's other approved leave, and entries changed since (no longer the leave
 * marker), are left alone.
 */
async function releaseAvailabilityForCancelledLeave(timeOffRequest) {
  const userId = timeOffRequest.user_id;
  const otherLeave = await TimeOffRequest.find({
    _id: { $ne: timeOffRequest._id },
    user_id: userId,
    status: 'approved',
    start_date: { $lte: timeOffRequest.end_date },
    end_date: { $gte: timeOffRequest.start_date }
  }).select('start_date end_date');

  const stillOnLeave = new Set(otherLeave.flatMap((l) => eachDateInRange(l.start_date, l.end_date)));
  const dates = eachDateInRange(timeOffRequest.start_date, timeOffRequest.end_date)
    .filter((d) => !stillOnLeave.has(d));
  if (!dates.length) return;

  await Availability.deleteMany({
    user_id: userId,
    date: { $in: dates },
    is_available: false,
    notes: { $regex: `^${APPROVED_LEAVE_NOTE_PREFIX}` }
  });
}

module.exports = {
  findTimetableConflictForLeave,
  buildAutoDenialReason,
  syncAvailabilityForApprovedLeave,
  releaseAvailabilityForCancelledLeave,
  findHomeLeaveLimitConflict,
  buildHomeLeaveLimitMessage,
  REQUEST_TYPE_LABELS
};
