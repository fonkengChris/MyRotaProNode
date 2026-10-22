const AISolver = require('../../../services/aiSolver');
const SolverSettings = require('../../../models/SolverSettings');

const clone = (o) => JSON.parse(JSON.stringify(o));

function makeSolver(overrides = {}) {
  const solver = new AISolver();
  solver.settings = { ...clone(SolverSettings.DEFAULTS), ...overrides };
  return solver;
}

let seq = 0;
const shift = (date, start_time, end_time, extra = {}) => ({
  _id: `s${seq++}`,
  date,
  start_time,
  end_time,
  shift_type: 'day',
  home_id: 'home1',
  required_staff_count: 1,
  assigned_staff: [],
  ...extra
});

describe('AISolver rest and overlap', () => {
  test('a night shift ending when a held shift starts is rejected, whichever is earlier', () => {
    const solver = makeSolver();
    const night = shift('2026-10-05', '20:00', '08:00');
    const nextDay = shift('2026-10-06', '08:00', '20:00');
    // Previously only one direction was measured, so this reported 24h rest.
    expect(solver.violatesRestOrOverlap(night, [nextDay])).toBe(true);
    expect(solver.violatesRestOrOverlap(nextDay, [night])).toBe(true);
  });

  test('min_rest_hours controls the allowed gap', () => {
    const early = shift('2026-10-05', '08:00', '18:00');
    const nextEarly = shift('2026-10-06', '04:00', '12:00'); // 10h after the first ends
    expect(makeSolver().violatesRestOrOverlap(nextEarly, [early])).toBe(false);
    expect(makeSolver({ min_rest_hours: 11 }).violatesRestOrOverlap(nextEarly, [early])).toBe(true);
  });

  test('overlap is always rejected, even with zero required rest', () => {
    const solver = makeSolver({ min_rest_hours: 0 });
    const a = shift('2026-10-05', '08:00', '14:00');
    const b = shift('2026-10-05', '12:00', '18:00');
    const c = shift('2026-10-05', '14:00', '20:00');
    expect(solver.violatesRestOrOverlap(b, [a])).toBe(true);
    expect(solver.violatesRestOrOverlap(c, [a])).toBe(false);
  });

  test('1-to-1 shifts do not block a background shift', () => {
    const solver = makeSolver();
    const oneToOne = shift('2026-10-05', '10:00', '12:00', { shift_type: 'one_to_one' });
    const background = shift('2026-10-05', '08:00', '20:00');
    expect(solver.violatesRestOrOverlap(background, [oneToOne])).toBe(false);
  });
});

describe('AISolver consecutive days', () => {
  const dates = (...ymds) => new Set(ymds);

  test('on by default with a 6-day limit', () => {
    const solver = makeSolver();
    const six = dates('2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06');
    expect(solver.exceedsConsecutiveDays(six, '2026-10-07')).toBe(true);
    expect(makeSolver({ consecutive_days_enabled: false }).exceedsConsecutiveDays(six, '2026-10-07')).toBe(false);
  });

  test('counts runs on both sides of the candidate day', () => {
    const solver = makeSolver({ consecutive_days_enabled: true, max_consecutive_days: 3 });
    expect(solver.exceedsConsecutiveDays(dates('2026-10-01', '2026-10-02'), '2026-10-03')).toBe(false);
    expect(solver.exceedsConsecutiveDays(dates('2026-10-01', '2026-10-02', '2026-10-04'), '2026-10-03')).toBe(true);
    // Already working that day: a second shift doesn't lengthen the run.
    expect(solver.exceedsConsecutiveDays(dates('2026-10-01', '2026-10-02', '2026-10-03'), '2026-10-03')).toBe(false);
  });
});

describe('AISolver same shift in a row', () => {
  const nights = (...ymds) => ymds.map((d) => shift(d, '22:00', '08:00', { shift_type: 'night-sleep' }));

  test('limits runs of the same shift, counting both sides of the candidate day', () => {
    const solver = makeSolver({ max_same_shift_in_a_row: 3 });
    const [candidate] = nights('2026-10-03');
    expect(solver.exceedsSameShiftRun(nights('2026-10-01', '2026-10-02'), candidate)).toBe(false);
    expect(solver.exceedsSameShiftRun(nights('2026-10-01', '2026-10-02', '2026-10-04'), candidate)).toBe(true);
  });

  test('a different shift on the neighbouring days does not count', () => {
    const solver = makeSolver({ max_same_shift_in_a_row: 2 });
    const held = [...nights('2026-10-01'), shift('2026-10-02', '22:00', '08:00', { shift_type: 'night-wake' })];
    expect(solver.exceedsSameShiftRun(held, nights('2026-10-03')[0])).toBe(false);
  });

  test('greedy rotates the same night off one person, but still fills it as a last resort', () => {
    const solver = makeSolver({ max_same_shift_in_a_row: 2, consecutive_days_enabled: false });
    const week = nights('2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08');
    const member = (id) => ({ _id: id, name: id, type: 'fulltime', role: 'support_worker', homes: [{ home_id: 'home1', is_default: true }] });
    const constraints = (scores) => Object.fromEntries(
      Object.entries(scores).map(([id, sc]) => [id, Object.fromEntries(week.map((s) => [s._id, sc]))])
    );
    const run = (staff, scores) => solver.greedyMultiHomeAssignment(week, staff, constraints(scores), ['home1'], {
      overlapContextShifts: week, segmentShiftsForHours: week
    }).map((r) => r.assignments[0] && r.assignments[0].user_id);

    // u1 outscores u2 every night, but never does more than 2 nights in a row.
    expect(run([member('u1'), member('u2')], { u1: 120, u2: 100 })).toEqual(['u1', 'u1', 'u2', 'u1']);
    // With nobody else available the shift is still filled.
    expect(run([member('u1')], { u1: 100 })).toEqual(['u1', 'u1', 'u1', 'u1']);
  });
});

describe('AISolver greedy assignment', () => {
  const staffMember = (id, type = 'fulltime') => ({
    _id: id, name: id, type, role: 'support_worker', homes: [{ home_id: 'home1', is_default: true }]
  });

  test('does not give one person two overlapping shifts in the same pass', () => {
    const solver = makeSolver();
    const a = shift('2026-10-05', '08:00', '20:00');
    const b = shift('2026-10-05', '09:00', '17:00');
    const staff = [staffMember('u1')];
    const constraints = { u1: { [a._id]: 100, [b._id]: 100 } };
    const rows = solver.greedyMultiHomeAssignment([a, b], staff, constraints, ['home1'], {
      overlapContextShifts: [a, b], segmentShiftsForHours: [a, b]
    });
    const assigned = rows.flatMap((r) => r.assignments);
    expect(assigned).toHaveLength(1);
  });

  test('full-time limit is 48 paid hours after breaks, including existing 1-to-1 hours', () => {
    const solver = makeSolver();
    const s12 = shift('2026-10-05', '08:00', '20:00'); // 12h rostered, 11h after the 1h break
    const staff = [staffMember('u1')];
    const constraints = { u1: { [s12._id]: 100 } };
    const run = (baseHoursByUser) => solver.greedyMultiHomeAssignment([s12], staff, constraints, ['home1'], {
      overlapContextShifts: [s12], segmentShiftsForHours: [s12], baseHoursByUser
    }).flatMap((r) => r.assignments);
    expect(run({ u1: 37 })).toHaveLength(1); // 37 + 11 = 48
    expect(run({ u1: 37.5 })).toHaveLength(0); // 48.5
  });

  test('respects the hard weekly hours limit from settings', () => {
    const solver = makeSolver();
    solver.settings.hours.parttime.hard_max = 12;
    const days = ['2026-10-05', '2026-10-06'].map((d) => shift(d, '08:00', '18:00'));
    const staff = [staffMember('u1', 'parttime')];
    const constraints = { u1: Object.fromEntries(days.map((s) => [s._id, 100])) };
    const rows = solver.greedyMultiHomeAssignment(days, staff, constraints, ['home1'], {
      overlapContextShifts: days, segmentShiftsForHours: days
    });
    expect(rows.flatMap((r) => r.assignments)).toHaveLength(1);
  });
});

describe('AISolver swap validation', () => {
  test('a swap that would breach the weekly hours limit is not applied', () => {
    const solver = makeSolver();
    solver.settings.hours.parttime.hard_max = 10;
    const short = shift('2026-10-05', '08:00', '12:00'); // 4h
    const long = shift('2026-10-07', '08:00', '20:00'); // 12h
    const staff = [
      { _id: 'pt', type: 'parttime', homes: [] },
      { _id: 'ft', type: 'fulltime', homes: [] }
    ];
    const rows = [
      { shift: short, assignments: [{ user_id: 'pt', score: 10 }] },
      { shift: long, assignments: [{ user_id: 'ft', score: 10 }] }
    ];
    // Swapping looks better on score alone, but would put the part-timer on 12h.
    const constraints = { pt: { [short._id]: 10, [long._id]: 100 }, ft: { [short._id]: 100, [long._id]: 10 } };
    solver.localSearchOptimization(rows, constraints, {
      overlapContextShifts: [short, long], segmentShiftsForHours: [short, long], staff
    });
    expect(rows[0].assignments[0].user_id).toBe('pt');
    expect(rows[1].assignments[0].user_id).toBe('ft');
  });

  test('a swap into a shift the person is unavailable for is not applied', () => {
    const solver = makeSolver();
    const s1 = shift('2026-10-05', '08:00', '12:00');
    const s2 = shift('2026-10-07', '08:00', '12:00');
    const staff = [{ _id: 'a', type: 'fulltime', homes: [] }, { _id: 'b', type: 'fulltime', homes: [] }];
    const rows = [
      { shift: s1, assignments: [{ user_id: 'a', score: 10 }] },
      { shift: s2, assignments: [{ user_id: 'b', score: 10 }] }
    ];
    const constraints = { a: { [s1._id]: 10, [s2._id]: 200 }, b: { [s1._id]: 0, [s2._id]: 10 } };
    solver.localSearchOptimization(rows, constraints, {
      overlapContextShifts: [s1, s2], segmentShiftsForHours: [s1, s2], staff
    });
    expect(rows[0].assignments[0].user_id).toBe('a');
  });
});
