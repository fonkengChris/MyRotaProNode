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

  test('two outreach shifts only need outreach_min_rest_hours between them', () => {
    const solver = makeSolver();
    solver.outreachHomeIds = new Set(['outreach1', 'outreach2']);
    const morning = shift('2026-10-05', '08:00', '14:00', { home_id: 'outreach1' });
    const afterHalfHour = shift('2026-10-05', '14:30', '21:00', { home_id: 'outreach2' });
    const afterTenMins = shift('2026-10-05', '14:10', '21:00', { home_id: 'outreach1' });
    expect(solver.violatesRestOrOverlap(afterHalfHour, [morning])).toBe(false);
    expect(solver.violatesRestOrOverlap(afterTenMins, [morning])).toBe(true);
  });

  test('the normal rest rule applies when only one shift is outreach', () => {
    const solver = makeSolver();
    solver.outreachHomeIds = new Set(['outreach1']);
    const outreach = shift('2026-10-05', '08:00', '14:00', { home_id: 'outreach1' });
    const supportedLiving = shift('2026-10-05', '15:00', '21:00', { home_id: 'home1' });
    expect(solver.violatesRestOrOverlap(supportedLiving, [outreach])).toBe(true);
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

describe('AISolver availability preferences', () => {
  const staffMember = { _id: 'u1', name: 'u1', type: 'parttime', role: 'support_worker', homes: [{ home_id: 'home1', is_default: true }] };
  const availability = (extra) => ({
    user_id: 'u1', date: '2026-10-05', start_time: '06:00', end_time: '22:00', is_available: true, ...extra
  });
  const scoreFor = (s, availabilityData) => {
    const solver = makeSolver();
    return solver.buildMultiHomeConstraintMatrix([s], [staffMember], availabilityData, [], ['home1'])['u1'][s._id];
  };

  test('penalises a shift type other than the preferred one', () => {
    const s = shift('2026-10-05', '08:00', '16:00', { shift_type: 'day' });
    const penalty = SolverSettings.DEFAULTS.scoring.non_preferred_shift_type_penalty;
    const matching = scoreFor(s, [availability({ preferred_shift_type: 'day' })]);
    const other = scoreFor(s, [availability({ preferred_shift_type: 'night-wake' })]);
    expect(matching - other).toBe(penalty);
  });

  test("'none' means no preference, so no penalty", () => {
    const s = shift('2026-10-05', '08:00', '16:00', { shift_type: 'day' });
    expect(scoreFor(s, [availability({ preferred_shift_type: 'none' })]))
      .toBe(scoreFor(s, [availability({ preferred_shift_type: 'day' })]));
  });

  test('a day marked unavailable scores zero', () => {
    const s = shift('2026-10-05', '08:00', '16:00');
    expect(scoreFor(s, [availability({ is_available: false })])).toBe(0);
  });

  test("a day marked status 'unavailable' scores zero", () => {
    const s = shift('2026-10-05', '08:00', '16:00');
    expect(scoreFor(s, [availability({ status: 'unavailable' })])).toBe(0);
  });

  test('a partial day only allows shifts inside its hours', () => {
    const window = [availability({ status: 'partial', start_time: '09:00', end_time: '17:00' })];
    expect(scoreFor(shift('2026-10-05', '09:00', '17:00'), window)).toBeGreaterThan(0);
    expect(scoreFor(shift('2026-10-05', '16:00', '23:00'), window)).toBe(0);
    expect(scoreFor(shift('2026-10-05', '08:00', '12:00'), window)).toBe(0);
  });

  test("an available day's old time range is not a restriction", () => {
    const s = shift('2026-10-05', '16:00', '23:00');
    expect(scoreFor(s, [availability({ status: 'available', start_time: '09:00', end_time: '17:00' })]))
      .toBe(scoreFor(s, []));
  });
});

describe('AISolver overnight shifts check the next day', () => {
  const staffMember = { _id: 'u1', name: 'u1', type: 'parttime', role: 'support_worker', homes: [{ home_id: 'home1', is_default: true }] };
  const scoreFor = (s, availabilityData, timeOffData = []) =>
    makeSolver().buildMultiHomeConstraintMatrix([s], [staffMember], availabilityData, timeOffData, ['home1'])['u1'][s._id];
  const unavailable = (date) => ({ user_id: 'u1', date, start_time: '00:00', end_time: '23:59', is_available: false });
  const leave = (start_date, end_date) => ({ user_id: 'u1', start_date, end_date, status: 'approved' });

  test('a night shift is blocked when the next day is marked unavailable', () => {
    expect(scoreFor(shift('2026-10-05', '22:00', '08:00'), [unavailable('2026-10-06')])).toBe(0);
  });

  test('a night shift is blocked when leave starts the next day', () => {
    expect(scoreFor(shift('2026-10-05', '22:00', '08:00'), [], [leave('2026-10-06', '2026-10-08')])).toBe(0);
  });

  test("a night shift must end inside the next day's partial hours", () => {
    const partial = (start_time, end_time) => ({ user_id: 'u1', date: '2026-10-06', status: 'partial', start_time, end_time });
    const night = shift('2026-10-05', '22:00', '08:00');
    expect(scoreFor(night, [partial('10:00', '18:00')])).toBe(0);
    expect(scoreFor(night, [partial('00:00', '12:00')])).toBeGreaterThan(0);
  });

  test("a day shift ignores the next day's unavailability and leave", () => {
    const s = shift('2026-10-05', '08:00', '16:00');
    expect(scoreFor(s, [unavailable('2026-10-06')], [leave('2026-10-06', '2026-10-06')])).toBeGreaterThan(0);
  });

  test('a Sunday night shift fetches the following Monday', async () => {
    const Availability = require('../../../models/Availability');
    const TimeOffRequest = require('../../../models/TimeOffRequest');
    const av = jest.spyOn(Availability, 'find').mockResolvedValue([]);
    const to = jest.spyOn(TimeOffRequest, 'find').mockResolvedValue([]);
    const solver = makeSolver();
    await solver.getAvailabilityData(['u1'], new Date('2026-10-05'), new Date('2026-10-11'));
    await solver.getTimeOffData(['u1'], new Date('2026-10-05'), new Date('2026-10-11'));
    expect(av.mock.calls[0][0].date).toEqual({ $gte: '2026-10-05', $lte: '2026-10-12' });
    expect(to.mock.calls[0][0].start_date).toEqual({ $lte: '2026-10-12' });
    jest.restoreAllMocks();
  });
});

describe('AISolver dates ignore the server timezone', () => {
  test('week segments use the requested calendar days', () => {
    const segs = makeSolver().computeWeekSegments(new Date('2026-07-06'), new Date('2026-07-19'));
    expect(segs.map((s) => [s.startStr, s.endStr])).toEqual([['2026-07-06', '2026-07-12'], ['2026-07-13', '2026-07-19']]);
  });

  test('a final partial week ends on the end date', () => {
    const segs = makeSolver().computeWeekSegments('2026-07-06', '2026-07-15');
    expect(segs.map((s) => s.endStr)).toEqual(['2026-07-12', '2026-07-15']);
  });

  test('weekly schedule shifts land on the right weekday', async () => {
    const WeeklySchedule = require('../../../models/WeeklySchedule');
    const pattern = { start_time: '08:00', end_time: '16:00', shift_type: 'day', required_staff_count: 1, service_id: 'svc' };
    const day = (on) => ({ is_active: on, shifts: on ? [pattern] : [] });
    jest.spyOn(WeeklySchedule, 'findOne').mockResolvedValue({
      schedule: { monday: day(true), tuesday: day(false), wednesday: day(false), thursday: day(false), friday: day(false), saturday: day(false), sunday: day(false) }
    });
    const shifts = await makeSolver().generateShiftsFromWeeklySchedule(new Date('2026-07-06'), new Date('2026-07-12'), 'home1');
    expect(shifts.map((s) => s.date.toISOString().slice(0, 10))).toEqual(['2026-07-06']);
    jest.restoreAllMocks();
  });
});

describe('shiftFitsWindow', () => {
  const { shiftFitsWindow } = require('../../../utils/availability');
  const fits = (start, end, winStart, winEnd) =>
    shiftFitsWindow({ start_time: start, end_time: end }, winStart, winEnd);

  test('day shift inside and outside a day window', () => {
    expect(fits('09:00', '17:00', '09:00', '17:00')).toBe(true);
    expect(fits('16:00', '00:00', '09:00', '17:00')).toBe(false);
    expect(fits('08:00', '12:00', '09:00', '17:00')).toBe(false);
  });

  test('a window ending 23:59 covers a shift ending at midnight', () => {
    expect(fits('16:00', '00:00', '09:00', '23:59')).toBe(true);
  });

  test('overnight shift needs an overnight window', () => {
    expect(fits('22:00', '08:00', '20:00', '09:00')).toBe(true);
    expect(fits('22:00', '08:00', '06:00', '23:59')).toBe(false);
  });

  test('an overnight window covers a shift after midnight', () => {
    expect(fits('02:00', '06:00', '20:00', '08:00')).toBe(true);
    expect(fits('07:00', '10:00', '20:00', '08:00')).toBe(false);
  });
});

describe('AISolver data fetches fail closed', () => {
  const Availability = require('../../../models/Availability');
  const TimeOffRequest = require('../../../models/TimeOffRequest');
  const start = new Date('2026-10-05');
  const end = new Date('2026-10-11');

  afterEach(() => jest.restoreAllMocks());

  test('a failed availability fetch throws rather than returning no records', async () => {
    jest.spyOn(Availability, 'find').mockRejectedValue(new Error('db down'));
    await expect(makeSolver().getAvailabilityData(['u1'], start, end)).rejects.toThrow('db down');
  });

  test('a failed time-off fetch throws rather than returning no leave', async () => {
    jest.spyOn(TimeOffRequest, 'find').mockRejectedValue(new Error('db down'));
    await expect(makeSolver().getTimeOffData(['u1'], start, end)).rejects.toThrow('db down');
  });
});
