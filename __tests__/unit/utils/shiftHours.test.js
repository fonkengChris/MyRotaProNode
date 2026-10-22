const {
  getShiftHourBreakdown,
  workedHourBreakdown,
  setSleepInHours,
  DEFAULT_SLEEP_IN_HOURS,
} = require('../../../utils/shiftHours');
const { shiftStartDate } = require('../../../utils/shiftTime');

const sleepShift = (start_time, end_time, date = '2026-01-12') => ({
  date,
  start_time,
  end_time,
  shift_type: 'night-sleep',
});
const H = 3600000;

describe('night-sleep hours: sleep is the last N hours of the shift', () => {
  afterEach(() => setSleepInHours(DEFAULT_SLEEP_IN_HOURS));

  test.each([
    // [start, end, duration, sleep, regular]
    ['20:00', '08:00', 12, 9, 3],
    ['19:00', '07:00', 12, 9, 3],
    ['21:00', '09:00', 12, 9, 3],
    ['23:00', '08:00', 9, 9, 0],
    ['00:00', '09:00', 9, 9, 0],
    ['22:00', '06:00', 8, 8, 0],
    ['20:00', '10:00', 14, 9, 5],
  ])('%s–%s → %ih: %ih sleep, %ih regular', (start, end, duration, sleep, regular) => {
    expect(getShiftHourBreakdown(sleepShift(start, end))).toEqual({
      duration_hours: duration,
      sleep_in_hours: sleep,
      paid_work_hours: regular,
    });
  });

  test('the sleep length follows the admin setting', () => {
    setSleepInHours(8);
    expect(getShiftHourBreakdown(sleepShift('20:00', '08:00'))).toMatchObject({
      sleep_in_hours: 8,
      paid_work_hours: 4,
    });
  });

  test('other shift types are not split', () => {
    const wake = { ...sleepShift('20:00', '08:00'), shift_type: 'night-wake' };
    expect(getShiftHourBreakdown(wake)).toMatchObject({ sleep_in_hours: 0, paid_work_hours: 12 });
  });

  describe('clocked time: the sleep block stays on the rota times', () => {
    const shift = sleepShift('20:00', '08:00'); // sleep 23:00 → 08:00
    const start = () => shiftStartDate(shift).getTime();
    const clocked = (inOffsetH, outOffsetH) => ({
      clock_in_time: new Date(start() + inOffsetH * H),
      clock_out_time: new Date(start() + outOffsetH * H),
    });

    test('full attendance matches the rota', () => {
      expect(workedHourBreakdown(shift, clocked(0, 12))).toMatchObject({ sleep_in_hours: 9, paid_work_hours: 3 });
    });

    test('arriving an hour late cuts regular hours', () => {
      expect(workedHourBreakdown(shift, clocked(1, 12))).toMatchObject({ sleep_in_hours: 9, paid_work_hours: 2 });
    });

    test('leaving an hour early cuts sleep hours', () => {
      expect(workedHourBreakdown(shift, clocked(0, 11))).toMatchObject({ sleep_in_hours: 8, paid_work_hours: 3 });
    });
  });
});
