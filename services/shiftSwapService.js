const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const User = require('../models/User');
const TimeOffRequest = require('../models/TimeOffRequest');
const ShiftSwap = require('../models/ShiftSwap');
const Home = require('../models/Home');
const SchedulingConflictService = require('./schedulingConflictService');
const { isOneToOne, shiftDateOffset } = require('../utils/oneToOne');
const { shiftStartDate } = require('../utils/shiftTime');
const { paidHoursAfterBreak } = require('../utils/shiftHours');

// A swap request expires after this many days if not answered (or sooner: when the earlier of
// its two shifts starts).
const SWAP_EXPIRY_DAYS = 7;

// Rota-rule conflicts a swap may break when both staff consent: the swap goes ahead and the
// affected assignment is flagged as a rest exception for admin review.
const CONSENTABLE_CONFLICT_TYPES = new Set(['insufficient_rest']);

// Paid hours are compared to the nearest minute or so, avoiding float noise.
const PAID_HOURS_TOLERANCE = 0.01;

const idOf = (ref) => String(ref && ref._id ? ref._id : ref);

/** True once the shift's scheduled start has passed. */
function hasStarted(shift, now = new Date()) {
  return shiftStartDate(shift).getTime() <= now.getTime();
}

function assignmentOf(shift, userId) {
  return (shift.assigned_staff || []).find((a) => idOf(a.user_id) === String(userId));
}

/** Calendar dates a shift touches: its date, plus the next day for an overnight shift. */
function shiftDates(shift) {
  const overnight = shift.end_time <= shift.start_time;
  return overnight ? [shift.date, shiftDateOffset(shift.date, 1)] : [shift.date];
}

/** Monday (YYYY-MM-DD) of the Monday–Sunday week a shift starts in. */
function weekStartOf(shift) {
  return SchedulingConflictService._weekRangeMondayToSunday(shift.date).start;
}

/** Paid work hours (after sleep-in and the home's break deduction), rounded for display. */
const fmtHours = (h) => `${Math.round(h * 100) / 100}h`;

/** Error raised when a swap can no longer be carried out because the rota changed. */
class SwapExecutionError extends Error {}

class ShiftSwapService {
  /**
   * When a new swap request between these two shifts should expire: SWAP_EXPIRY_DAYS from now,
   * or the start of the earlier shift if that is sooner.
   */
  expiryFor(requesterShift, targetShift) {
    const byDays = Date.now() + SWAP_EXPIRY_DAYS * 24 * 3600000;
    return new Date(Math.min(byDays, shiftStartDate(requesterShift).getTime(), shiftStartDate(targetShift).getTime()));
  }

  /**
   * Reasons a shift cannot be swapped at all, whoever is involved: inactive, a 1-to-1 (assigned
   * by admins only), or already started.
   */
  shiftBlockers(shift, label, now = new Date()) {
    if (!shift.is_active) {
      return [{ type: 'shift_inactive', message: `${label} is no longer active` }];
    }
    if (isOneToOne(shift)) {
      return [{ type: 'one_to_one_shift', message: `${label} is a 1-to-1 shift; only admins can reassign 1-to-1 shifts` }];
    }
    if (hasStarted(shift, now)) {
      return [{ type: 'shift_started', message: `${label} has already started` }];
    }
    return [];
  }

  /**
   * Check whether `requesterId` (on requesterShift) and `targetUserId` (on targetShift) can
   * exchange shifts. The shifts must be in the same home, start in the same Monday–Sunday week
   * and have equal paid hours (after sleep-in and the home's break deduction).
   *
   * Each person is then checked against the shift they would take on, as if the one they give
   * up were already gone, using the same rules as a manual assignment
   * (SchedulingConflictService): overlaps, the >24h day and the full-time weekly cap block, as
   * does leave (approved or pending) on any date the new shift touches. A breach of the minimum
   * rest rule does not block: it is returned in `restWarnings`, and the swap may go ahead once
   * both staff consent (the routes enforce that).
   *
   * @param {string} [excludeSwapId] - the swap being approved, ignored by the pending-swap check
   * @returns {Promise<{ hasConflict: boolean, conflicts: Array, restWarnings: Array }>}
   */
  async checkSwapConflicts(requesterShiftId, targetShiftId, requesterId, targetUserId, excludeSwapId = null) {
    try {
      const [requesterShift, targetShift, requester, targetUser] = await Promise.all([
        Shift.findById(requesterShiftId),
        Shift.findById(targetShiftId),
        User.findById(requesterId).select('name'),
        User.findById(targetUserId).select('name'),
      ]);

      if (!requesterShift || !targetShift) {
        return { hasConflict: true, conflicts: [{ type: 'shift_not_found', message: 'One or both shifts not found' }], restWarnings: [] };
      }
      if (!requester || !targetUser) {
        return { hasConflict: true, conflicts: [{ type: 'user_not_found', message: 'One or both users not found' }], restWarnings: [] };
      }

      const now = new Date();
      const conflicts = [
        ...this.shiftBlockers(requesterShift, 'The shift being given up', now),
        ...this.shiftBlockers(targetShift, 'The requested shift', now),
      ];

      // Each person must be on the shift they give up, and not already on the one they'd take.
      if (!assignmentOf(requesterShift, requesterId)) {
        conflicts.push({ type: 'assignment_mismatch', message: `${requester.name} is no longer assigned to the shift they want to give up` });
      }
      if (!assignmentOf(targetShift, targetUserId)) {
        conflicts.push({ type: 'assignment_mismatch', message: `${targetUser.name} is no longer assigned to the requested shift` });
      }
      if (assignmentOf(targetShift, requesterId)) {
        conflicts.push({ type: 'already_assigned', message: `${requester.name} is already assigned to the requested shift` });
      }
      if (assignmentOf(requesterShift, targetUserId)) {
        conflicts.push({ type: 'already_assigned', message: `${targetUser.name} is already assigned to the shift being given up` });
      }

      conflicts.push(...(await this.pairingConflicts(requesterShift, targetShift)));

      // Nothing else is meaningful if the swap itself is impossible.
      if (conflicts.length > 0) {
        return { hasConflict: true, conflicts, restWarnings: [] };
      }

      const [requesterRota, targetRota, requesterLeave, targetLeave, existingSwaps] = await Promise.all([
        this.rotaConflicts(requester, targetShift, requesterShift),
        this.rotaConflicts(targetUser, requesterShift, targetShift),
        this.checkTimeOffConflicts(requester, targetShift),
        this.checkTimeOffConflicts(targetUser, requesterShift),
        this.checkExistingSwapRequests(requesterShiftId, targetShiftId, excludeSwapId),
      ]);

      const rota = [
        ...requesterRota.map((c) => ({ ...c, user: 'requester' })),
        ...targetRota.map((c) => ({ ...c, user: 'target_user' })),
      ];
      const restWarnings = rota.filter((c) => CONSENTABLE_CONFLICT_TYPES.has(c.type));
      conflicts.push(...rota.filter((c) => !CONSENTABLE_CONFLICT_TYPES.has(c.type)));
      conflicts.push(...requesterLeave.map((c) => ({ ...c, user: 'requester' })));
      conflicts.push(...targetLeave.map((c) => ({ ...c, user: 'target_user' })));
      conflicts.push(...existingSwaps);

      return { hasConflict: conflicts.length > 0, conflicts, restWarnings };
    } catch (error) {
      console.error('Error checking swap conflicts:', error);
      return {
        hasConflict: true,
        conflicts: [{ type: 'system_error', message: 'Error occurred while checking conflicts' }],
        restWarnings: [],
      };
    }
  }

  /**
   * Which two shifts may be exchanged at all: same home, starting in the same Monday–Sunday
   * week, with equal paid hours (after sleep-in and the home's break deduction).
   */
  async pairingConflicts(shiftA, shiftB) {
    if (String(shiftA.home_id) !== String(shiftB.home_id)) {
      return [{ type: 'different_home', message: 'Shifts can only be swapped within the same home' }];
    }
    const conflicts = [];
    if (weekStartOf(shiftA) !== weekStartOf(shiftB)) {
      conflicts.push({ type: 'different_week', message: 'Shifts can only be swapped within the same week (Monday–Sunday)' });
    }
    const home = await Home.findById(shiftA.home_id).select('break_policy').lean();
    const paidA = paidHoursAfterBreak(shiftA, home && home.break_policy);
    const paidB = paidHoursAfterBreak(shiftB, home && home.break_policy);
    if (Math.abs(paidA - paidB) > PAID_HOURS_TOLERANCE) {
      conflicts.push({
        type: 'unequal_hours',
        message: `Shifts must have equal paid hours (${fmtHours(paidA)} vs ${fmtHours(paidB)})`,
      });
    }
    return conflicts;
  }

  /**
   * Rota-rule violations for `user` taking `newShift` once `givenUpShift` is off their rota,
   * via the shared manual-assignment check. Leave is checked separately (checkTimeOffConflicts
   * also covers pending leave and the second day of an overnight shift).
   */
  async rotaConflicts(user, newShift, givenUpShift) {
    const result = await SchedulingConflictService.checkShiftAssignmentConflict(
      String(user._id),
      newShift.date,
      newShift.start_time,
      newShift.end_time,
      {
        shiftType: newShift.shift_type,
        shiftId: String(newShift._id),
        homeId: newShift.home_id,
        excludeShiftIds: [String(givenUpShift._id)],
      }
    );
    if (!result.hasConflict) return [];

    if (result.conflictType === 'overlapping_shift') {
      return [{
        type: 'time_overlap',
        message: `${user.name} already has another shift overlapping ${newShift.start_time}–${newShift.end_time} on ${newShift.date}`,
      }];
    }
    return result.overridableConflicts
      .filter((c) => c.conflictType !== 'time_off')
      .map((c) => ({ type: c.conflictType, message: `${user.name}: ${c.message}`, details: c.details }));
  }

  /**
   * Approved or pending leave for `user` on any date `shift` touches (both days of an
   * overnight shift). Pending leave blocks too: a swap shouldn't put someone on a day they
   * have asked to have off while that request is undecided.
   */
  async checkTimeOffConflicts(user, shift) {
    const dates = shiftDates(shift);
    const leave = await TimeOffRequest.find({
      user_id: user._id,
      status: { $in: ['approved', 'pending'] },
      start_date: { $lte: dates[dates.length - 1] },
      end_date: { $gte: dates[0] },
    }).select('status start_date end_date');

    return leave.map((l) => ({
      type: 'time_off_conflict',
      message: `${user.name} has ${l.status === 'approved' ? 'approved' : 'a pending request for'} time off overlapping the shift on ${shift.date}`,
      timeOffRequestId: l._id,
    }));
  }

  /** Other live (pending, unexpired) swap requests already involving either shift. */
  async checkExistingSwapRequests(requesterShiftId, targetShiftId, excludeSwapId = null) {
    const query = {
      status: 'pending',
      expires_at: { $gt: new Date() },
      $or: [
        { requester_shift_id: requesterShiftId },
        { target_shift_id: requesterShiftId },
        { requester_shift_id: targetShiftId },
        { target_shift_id: targetShiftId },
      ],
    };
    if (excludeSwapId) query._id = { $ne: excludeSwapId };

    const existingSwaps = await ShiftSwap.find(query).select('_id');
    return existingSwaps.map((swap) => ({
      type: 'existing_swap_request',
      message: 'One or both shifts are already involved in a pending swap request',
      existingSwapId: swap._id,
    }));
  }

  /**
   * Swaps `userId` could request: for each of their upcoming non-1-to-1 shifts in the range,
   * other upcoming non-1-to-1 shifts in the same home and the same Monday–Sunday week with equal
   * paid hours, with the colleagues on them who could take the user's shift. A colleague is
   * listed only when checkSwapConflicts finds nothing blocking; any rest-rule breach that would
   * need both staff's consent is returned as `rest_warnings`.
   */
  async findSwapOptions(userId, { start_date, end_date, home_id } = {}) {
    const now = new Date();
    const userShifts = await Shift.find({
      'assigned_staff.user_id': userId,
      is_active: true,
      shift_type: { $ne: 'one_to_one' },
      ...(start_date && end_date && { date: { $gte: start_date, $lte: end_date } }),
      ...(home_id && { home_id }),
    }).populate('service_id', 'name').populate('home_id', 'name break_policy');

    const perShift = await Promise.all(
      userShifts
        .filter((s) => !hasStarted(s, now))
        .map(async (userShift) => {
          const breakPolicy = userShift.home_id.break_policy;
          const paid = paidHoursAfterBreak(userShift, breakPolicy);
          const week = SchedulingConflictService._weekRangeMondayToSunday(userShift.date);
          const otherShifts = await Shift.find({
            home_id: userShift.home_id._id,
            date: { $gte: week.start, $lte: week.end },
            'assigned_staff.user_id': { $ne: userId },
            is_active: true,
            shift_type: { $ne: 'one_to_one' },
            _id: { $ne: userShift._id },
          }).populate('assigned_staff.user_id', 'name email').populate('service_id', 'name');

          const options = await Promise.all(
            otherShifts
              .filter((s) => !hasStarted(s, now))
              .filter((s) => Math.abs(paidHoursAfterBreak(s, breakPolicy) - paid) <= PAID_HOURS_TOLERANCE)
              .map(async (otherShift) => {
                const colleagues = otherShift.assigned_staff.filter((a) => a.user_id && a.user_id._id);
                const checks = await Promise.all(
                  colleagues.map((a) =>
                    this.checkSwapConflicts(String(userShift._id), String(otherShift._id), String(userId), String(a.user_id._id))
                  )
                );
                const swappers = colleagues
                  .map((a, i) => ({ a, check: checks[i] }))
                  .filter(({ check }) => !check.hasConflict)
                  .map(({ a, check }) => ({
                    user_id: a.user_id._id,
                    name: a.user_id.name,
                    email: a.user_id.email,
                    rest_warnings: check.restWarnings.map((w) => w.message),
                  }));
                return swappers.length
                  ? { user_shift: userShift, target_shift: otherShift, potential_swappers: swappers }
                  : null;
              })
          );
          return options.filter(Boolean);
        })
    );
    return perShift.flat();
  }

  /**
   * Execute an approved swap. Each shift is changed by a single conditional update that only
   * applies while the expected person is still on it (not clocked in) and the incoming person
   * isn't, so a rota change since approval can't half-apply. If the second update fails, the
   * first is reverted to the original assignment. Throws SwapExecutionError when the rota no
   * longer allows the swap; nothing is changed in that case.
   *
   * @param {object} [restExceptions] - whose new assignment breaks the minimum rest rule (by
   *   consent): `{ requester, target_user }`. Those are flagged 'pending' for admin review.
   */
  async executeSwap(swapId, restExceptions = {}) {
    const swap = await ShiftSwap.findById(swapId);
    if (!swap) throw new Error('Shift swap not found');
    if (swap.status !== 'approved') throw new Error('Only approved swaps can be executed');

    const requesterId = new mongoose.Types.ObjectId(idOf(swap.requester_id));
    const targetUserId = new mongoose.Types.ObjectId(idOf(swap.target_user_id));
    const requesterShiftId = idOf(swap.requester_shift_id);
    const targetShiftId = idOf(swap.target_shift_id);
    const note = `Assigned via shift swap (ID: ${swap._id})`;

    const [requesterShift, targetShift] = await Promise.all([
      Shift.findById(requesterShiftId).lean(),
      Shift.findById(targetShiftId).lean(),
    ]);
    const originalRequesterAssignment = requesterShift && assignmentOf(requesterShift, requesterId);
    if (!originalRequesterAssignment || !targetShift) {
      throw new SwapExecutionError('The rota has changed since this swap was requested');
    }

    // Replace `from`'s assignment on the shift with `assignment`, only if `from` is on it and
    // not clocked in, and `to` is not already on it.
    const replaceAssignment = (shiftId, from, to, assignment) =>
      Shift.updateOne(
        {
          _id: shiftId,
          is_active: true,
          $and: [
            { assigned_staff: { $elemMatch: { user_id: from, clock_in_time: null } } },
            { 'assigned_staff.user_id': { $ne: to } },
          ],
        },
        { $set: { 'assigned_staff.$[a]': assignment } },
        { arrayFilters: [{ 'a.user_id': from }] }
      );
    const freshAssignment = (userId, restException) => ({
      user_id: userId,
      status: 'assigned',
      assigned_at: new Date(),
      note,
      rest_exception_status: restException ? 'pending' : 'none',
    });

    const first = await replaceAssignment(
      requesterShiftId, requesterId, targetUserId, freshAssignment(targetUserId, restExceptions.target_user)
    );
    if (first.modifiedCount !== 1) {
      throw new SwapExecutionError('The rota has changed since this swap was requested');
    }

    const second = await replaceAssignment(
      targetShiftId, targetUserId, requesterId, freshAssignment(requesterId, restExceptions.requester)
    );
    if (second.modifiedCount !== 1) {
      // Put the requester's original assignment back so neither shift is left changed.
      await replaceAssignment(requesterShiftId, targetUserId, requesterId, originalRequesterAssignment);
      throw new SwapExecutionError('The rota has changed since this swap was requested');
    }

    await ShiftSwap.updateOne(
      { _id: swap._id, status: 'approved' },
      { $set: { status: 'completed', completed_at: new Date() } }
    );

    return {
      success: true,
      message: 'Shift swap executed successfully',
      swapId: swap._id,
      requesterShiftId,
      targetShiftId,
    };
  }
}

const service = new ShiftSwapService();
service.SwapExecutionError = SwapExecutionError;
module.exports = service;
