/**
 * Draft assignments.
 *
 * Auto-generation (timetables and the Rota Editor's Auto Generate) writes assignments with
 * `is_draft: true`. A draft is planned work, not yet allocated: planning checks (rest,
 * overlap, hours caps, solver, shift capacity) count it because it is about to go live,
 * but anything aimed at staff or money ignores it until an admin publishes it: shift reads
 * for staff, notifications, attendance, payroll and swaps.
 *
 * `draft_timetable_id` ties a draft to the timetable whose publish promotes it; drafts from
 * the Rota Editor have none and are published per home/week.
 */

function isDraftAssignment(assignment) {
  return assignment?.is_draft === true;
}

function isLiveAssignment(assignment) {
  return !isDraftAssignment(assignment);
}

/** `$elemMatch` body for "this user holds a live (non-draft) assignment". */
function liveAssignmentMatch(userId) {
  return { user_id: userId, is_draft: { $ne: true } };
}

/** A copy of the shift (lean or doc) without its draft assignments, for staff-facing reads. */
function stripDraftAssignments(shift) {
  if (!shift) return shift;
  const plain = typeof shift.toJSON === 'function' ? shift.toJSON() : { ...shift };
  if (Array.isArray(plain.assigned_staff)) {
    plain.assigned_staff = plain.assigned_staff.filter(isLiveAssignment);
  }
  return plain;
}

module.exports = {
  isDraftAssignment,
  isLiveAssignment,
  liveAssignmentMatch,
  stripDraftAssignments
};
