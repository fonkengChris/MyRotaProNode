const User = require('../models/User');
const Timetable = require('../models/Timetable');
const Shift = require('../models/Shift');
const Availability = require('../models/Availability');

const LOCKED_TIMETABLE_STATUSES = ['generated', 'published'];

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
 * Upsert daily availability as unavailable for each day of approved leave.
 */
async function syncAvailabilityForApprovedLeave(timeOffRequest) {
  const userId = timeOffRequest.user_id;
  const typeLabel = REQUEST_TYPE_LABELS[timeOffRequest.request_type] || timeOffRequest.request_type;
  const note = `Approved leave: ${typeLabel}`;
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

module.exports = {
  findTimetableConflictForLeave,
  buildAutoDenialReason,
  syncAvailabilityForApprovedLeave,
  REQUEST_TYPE_LABELS
};
