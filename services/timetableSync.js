const Timetable = require('../models/Timetable');
const Shift = require('../models/Shift');
const SchedulingConflictService = require('./schedulingConflictService');
const { getShiftHourBreakdown } = require('../utils/shiftHours');

// Timetables that have finished generating keep their weekly snapshots in step with the
// live Shift collection. Shift writes are batched per timetable so a bulk change (e.g. a
// rota unassign touching hundreds of shifts) triggers one rebuild, not hundreds.
const SYNC_DEBOUNCE_MS = 1500;
const SYNCABLE_STATUSES = ['draft', 'generated', 'published'];

const pendingTimers = new Map(); // timetableId -> timeout
const runningSyncs = new Map(); // timetableId -> promise
const rerunRequested = new Set();

function ymd(date) {
  return new Date(date).toISOString().split('T')[0];
}

// Last day in the snapshot: whole weeks from start_date, which can run past end_date.
function snapshotEndYmd(timetable) {
  const end = new Date(timetable.start_date);
  end.setDate(end.getDate() + timetable.total_weeks * 7 - 1);
  const endDate = ymd(timetable.end_date);
  return ymd(end) > endDate ? ymd(end) : endDate;
}

function calculateEmploymentDistribution(shifts) {
  const distribution = {
    fulltime: { total_hours: 0, staff_count: 0, average_hours: 0 },
    parttime: { total_hours: 0, staff_count: 0, average_hours: 0 },
    bank: { total_hours: 0, staff_count: 0, average_hours: 0 }
  };

  const staffHours = {};

  shifts.forEach(shift => {
    (shift.assigned_staff || []).forEach(assignment => {
      if (!assignment.user_id) return;
      const staffId = assignment.user_id._id.toString();
      const staffType = assignment.user_id.type;
      const hours = getShiftHourBreakdown(shift).paid_work_hours;

      if (!staffHours[staffId]) {
        staffHours[staffId] = { type: staffType, hours: 0 };
      }
      staffHours[staffId].hours += hours;
    });
  });

  Object.values(staffHours).forEach(staff => {
    if (distribution[staff.type]) {
      distribution[staff.type].total_hours += staff.hours;
      distribution[staff.type].staff_count++;
    }
  });

  Object.keys(distribution).forEach(type => {
    if (distribution[type].staff_count > 0) {
      distribution[type].average_hours = distribution[type].total_hours / distribution[type].staff_count;
    }
  });

  return distribution;
}

/**
 * Build weekly snapshots from the live shifts in the timetable's homes and date range.
 * Errors in a single week are collected rather than thrown so the other weeks still build.
 */
async function buildTimetableSnapshot(timetable) {
  let totalShifts = 0;
  let totalHours = 0;
  let totalAssignments = 0;
  let totalConflicts = 0;
  const weeklyRotas = [];
  const errors = [];

  for (let week = 0; week < timetable.total_weeks; week++) {
    try {
      const weekStart = new Date(timetable.start_date);
      weekStart.setDate(weekStart.getDate() + (week * 7));

      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      const weekShifts = await Shift.find({
        home_id: { $in: timetable.home_ids },
        date: { $gte: ymd(weekStart), $lte: ymd(weekEnd) }
      }).populate('assigned_staff.user_id', 'name role type');

      let weekConflicts = 0;
      for (const homeId of timetable.home_ids) {
        try {
          const conflicts = await SchedulingConflictService.getHomeConflicts(homeId, ymd(weekStart), ymd(weekEnd));
          weekConflicts += conflicts.totalConflicts;
        } catch (error) {
          console.warn(`Failed to check conflicts for home ${homeId}:`, error.message);
        }
      }
      totalConflicts += weekConflicts;

      const weekTotalShifts = weekShifts.length;
      const weekTotalHours = weekShifts.reduce((sum, shift) => sum + (shift.duration_hours || 0), 0);
      const weekTotalPaidWorkHours = weekShifts.reduce(
        (sum, shift) => sum + getShiftHourBreakdown(shift).paid_work_hours,
        0
      );
      const weekTotalAssignments = weekShifts.reduce((sum, shift) => sum + (shift.assigned_staff?.length || 0), 0);

      weeklyRotas.push({
        week_start_date: weekStart,
        week_end_date: weekEnd,
        week_number: week + 1,
        shifts: weekShifts.map(shift => {
          const br = getShiftHourBreakdown(shift);
          return {
            shift_id: shift._id,
            home_id: shift.home_id,
            service_id: shift.service_id,
            date: shift.date,
            start_time: shift.start_time,
            end_time: shift.end_time,
            shift_type: shift.shift_type,
            required_staff_count: shift.required_staff_count,
            // Assignments whose user has since been deleted can't be named, so drop them.
            assigned_staff: shift.assigned_staff
              .filter(assignment => assignment.user_id)
              .map(assignment => ({
                user_id: assignment.user_id._id,
                name: assignment.user_id.name,
                role: assignment.user_id.role,
                type: assignment.user_id.type,
                status: assignment.status,
                assigned_at: assignment.assigned_at
              })),
            notes: shift.notes,
            duration_hours: br.duration_hours,
            paid_work_hours: br.paid_work_hours,
            sleep_in_hours: br.sleep_in_hours
          };
        }),
        total_shifts: weekTotalShifts,
        total_hours: weekTotalHours,
        total_paid_work_hours: weekTotalPaidWorkHours,
        total_assignments: weekTotalAssignments,
        employment_distribution: calculateEmploymentDistribution(weekShifts)
      });

      totalShifts += weekTotalShifts;
      totalHours += weekTotalHours;
      totalAssignments += weekTotalAssignments;
    } catch (error) {
      console.error(`Error building timetable week ${week + 1}:`, error);
      errors.push({ week: week + 1, error: error.message, timestamp: new Date() });
    }
  }

  return { weeklyRotas, totalShifts, totalHours, totalAssignments, totalConflicts, errors };
}

function applySnapshot(timetable, snapshot) {
  timetable.weekly_rotas = snapshot.weeklyRotas;
  timetable.total_shifts = snapshot.totalShifts;
  timetable.total_hours = snapshot.totalHours;
  timetable.total_assignments = snapshot.totalAssignments;
  timetable.average_weekly_hours = timetable.total_weeks > 0 ? snapshot.totalHours / timetable.total_weeks : 0;
  timetable.conflicts_detected = snapshot.totalConflicts;
}

async function syncTimetable(timetableId) {
  const timetable = await Timetable.findById(timetableId);
  // Skip if deleted, archived, mid-generation, or a draft that was never generated.
  if (!timetable || !SYNCABLE_STATUSES.includes(timetable.status) || !timetable.generation_completed_at) {
    return;
  }

  const snapshot = await buildTimetableSnapshot(timetable);
  // Week-level failures leave the previous snapshot in place rather than saving a partial one.
  if (snapshot.errors.length > 0) {
    console.warn(`Timetable ${timetableId} auto-update skipped: ${snapshot.errors.length} week(s) failed`);
    return;
  }

  applySnapshot(timetable, snapshot);

  // Published timetables stay published; unpublished ones follow the same rule as generation:
  // clean (no generation errors, no conflicts) → generated, otherwise draft.
  if (timetable.status !== 'published') {
    const hasGenerationErrors = (timetable.generation_errors || []).length > 0;
    timetable.status = !hasGenerationErrors && snapshot.totalConflicts === 0 ? 'generated' : 'draft';
  }

  await timetable.save();
}

function runSync(timetableId) {
  if (runningSyncs.has(timetableId)) {
    // A change landed while this timetable was rebuilding; rebuild again once it finishes.
    rerunRequested.add(timetableId);
    return;
  }
  const run = syncTimetable(timetableId)
    .catch(error => console.error(`Timetable ${timetableId} auto-update failed:`, error))
    .finally(() => {
      runningSyncs.delete(timetableId);
      if (rerunRequested.delete(timetableId)) runSync(timetableId);
    });
  runningSyncs.set(timetableId, run);
}

function scheduleSync(timetableId) {
  clearTimeout(pendingTimers.get(timetableId));
  const timer = setTimeout(() => {
    pendingTimers.delete(timetableId);
    runSync(timetableId);
  }, SYNC_DEBOUNCE_MS);
  timer.unref?.();
  pendingTimers.set(timetableId, timer);
}

/**
 * Queue a snapshot refresh for every generated timetable covering any of the given shifts.
 * @param {Array<{home_id: *, date: string}>} changes
 */
async function queueTimetableSyncForShifts(changes) {
  const valid = (changes || []).filter(c => c && c.home_id && c.date);
  if (valid.length === 0) return;

  const homeIds = [...new Set(valid.map(c => c.home_id.toString()))];
  const dates = valid.map(c => String(c.date).slice(0, 10)).sort();

  const timetables = await Timetable.find({
    home_ids: { $in: homeIds },
    status: { $in: SYNCABLE_STATUSES },
    generation_completed_at: { $ne: null },
    start_date: { $lte: new Date(`${dates[dates.length - 1]}T23:59:59.999Z`) }
  }).select('_id home_ids start_date end_date total_weeks');

  for (const tt of timetables) {
    const ttHomes = new Set(tt.home_ids.map(String));
    const ttStart = ymd(tt.start_date);
    const ttEnd = snapshotEndYmd(tt);
    const touched = valid.some(c => {
      const d = String(c.date).slice(0, 10);
      return ttHomes.has(c.home_id.toString()) && d >= ttStart && d <= ttEnd;
    });
    if (touched) scheduleSync(tt._id.toString());
  }
}

module.exports = {
  buildTimetableSnapshot,
  applySnapshot,
  calculateEmploymentDistribution,
  queueTimetableSyncForShifts,
  syncTimetable
};
