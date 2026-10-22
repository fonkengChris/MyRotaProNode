process.env.NODE_ENV = 'test';

const {
  shiftWindow,
  paidPortion,
  subtractIntervals,
  isCoveredBy,
  extraRosteredHours,
} = require('../../../utils/oneToOne');

const H = 3600000;
const shift = (date, start_time, end_time, shift_type = 'day', _id = `${date}-${start_time}`) => ({
  _id,
  date,
  start_time,
  end_time,
  shift_type,
});

describe('subtractIntervals', () => {
  const base = { startMs: 0, endMs: 8 * H };

  test('no cuts leaves the whole window', () => {
    expect(subtractIntervals(base, []).hours).toBe(8);
  });

  test('a covering cut removes everything', () => {
    expect(subtractIntervals(base, [{ startMs: -H, endMs: 9 * H }]).hours).toBe(0);
  });

  test('a partial cut leaves only the uncovered part', () => {
    const r = subtractIntervals(base, [{ startMs: 0, endMs: 6 * H }]);
    expect(r.hours).toBe(2);
    expect(r.intervals).toEqual([{ startMs: 6 * H, endMs: 8 * H }]);
  });

  test('a middle cut splits the window', () => {
    const r = subtractIntervals(base, [{ startMs: 2 * H, endMs: 3 * H }]);
    expect(r.hours).toBe(7);
    expect(r.intervals).toHaveLength(2);
  });

  test('overlapping cuts are not double-subtracted', () => {
    const r = subtractIntervals(base, [
      { startMs: 0, endMs: 4 * H },
      { startMs: 2 * H, endMs: 5 * H },
    ]);
    expect(r.hours).toBe(3);
  });
});

describe('coverage and extra hours', () => {
  const background = shift('2026-01-13', '08:00', '14:00');

  test('a 1-to-1 fully inside a background shift is covered and adds 0h', () => {
    const oneToOne = shift('2026-01-13', '09:00', '11:00', 'one_to_one');
    expect(isCoveredBy(oneToOne, [background])).toBe(true);
    expect(extraRosteredHours(oneToOne, [background])).toBe(0);
  });

  test('a partial overlap only adds the time outside the background shift', () => {
    const oneToOne = shift('2026-01-13', '12:00', '16:00', 'one_to_one');
    expect(isCoveredBy(oneToOne, [background])).toBe(false);
    expect(extraRosteredHours(oneToOne, [background])).toBe(2);
  });

  test('a 1-to-1 with no background shift adds its full length', () => {
    const oneToOne = shift('2026-01-13', '18:00', '21:00', 'one_to_one');
    expect(isCoveredBy(oneToOne, [background])).toBe(false);
    expect(extraRosteredHours(oneToOne, [background])).toBe(3);
  });

  test('an overnight background shift covers an early-morning 1-to-1 the next day', () => {
    const night = shift('2026-01-12', '20:00', '08:00', 'night-wake');
    const oneToOne = shift('2026-01-13', '02:00', '04:00', 'one_to_one');
    expect(isCoveredBy(oneToOne, [night])).toBe(true);
    expect(extraRosteredHours(oneToOne, [night])).toBe(0);
  });

  test('a 1-to-1 during the sleep-in part of a night-sleep shift is extra paid time', () => {
    // 11h shift: sleep is the last 9h (22:00 → 07:00), 20:00 → 22:00 is paid.
    const sleep = shift('2026-01-12', '20:00', '07:00', 'night-sleep');
    const oneToOne = shift('2026-01-13', '02:00', '04:00', 'one_to_one');
    expect(isCoveredBy(oneToOne, [sleep])).toBe(false);
    expect(extraRosteredHours(oneToOne, [sleep])).toBe(2);
    const paid = paidPortion(sleep, shiftWindow(sleep));
    expect((paid.endMs - paid.startMs) / H).toBe(2); // 20:00 → 22:00
  });
});
