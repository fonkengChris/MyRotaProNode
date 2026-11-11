/**
 * Day availability: each record is `available` (any time), `unavailable` (not at all) or
 * `partial` (only between start_time and end_time). A day with no record counts as available.
 * Used by the AI solver and by manual assignment so both apply the same rule.
 */

const AVAILABILITY_STATUSES = ['available', 'unavailable', 'partial'];

const DAY = 24 * 60;

const toMinutes = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/** A record's status; records saved before `status` existed only have `is_available`. */
function availabilityStatus(record) {
  if (!record) return 'available';
  if (AVAILABILITY_STATUSES.includes(record.status)) return record.status;
  return record.is_available === false ? 'unavailable' : 'available';
}

/**
 * [start, end) of a window in minutes from the start of its day. An end at or before the start
 * runs past midnight; an end of 23:59 counts as midnight.
 */
function windowMinutes(windowStart, windowEnd) {
  const start = toMinutes(windowStart);
  let end = toMinutes(windowEnd);
  if (end === DAY - 1) end = DAY;
  if (end <= start) end += DAY;
  return [start, end];
}

// Whether the whole shift (start to end, not just its start) sits inside the window. Either may
// run past midnight; an overnight window also covers a shift starting after midnight (e.g.
// 20:00-08:00 holds 02:00-06:00).
function shiftFitsWindow(shift, windowStart, windowEnd) {
  const [shiftStart, shiftEnd] = windowMinutes(shift.start_time, shift.end_time);
  const [winStart, winEnd] = windowMinutes(windowStart, windowEnd);
  return [0, DAY].some(offset => shiftStart + offset >= winStart && shiftEnd + offset <= winEnd);
}

const formatDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
  });
};

/**
 * Why `shift` falls outside the person's declared availability, or null if it doesn't.
 * `dayRecord` is their record for the shift's date; `nextDayRecord` the one for the following
 * date, which only matters when the shift runs past midnight: its part after midnight must
 * also fit that day's record.
 *
 * @returns {null | { date: string, status: 'unavailable' | 'partial', message: string }}
 */
function availabilityConflict(shift, dayRecord, nextDayRecord) {
  const date = shift.date;
  const dayStatus = availabilityStatus(dayRecord);
  if (dayStatus === 'unavailable') {
    return { date, status: 'unavailable', message: `Marked unavailable on ${formatDate(date)}` };
  }
  if (dayStatus === 'partial' && !shiftFitsWindow(shift, dayRecord.start_time, dayRecord.end_time)) {
    return {
      date,
      status: 'partial',
      message: `Only available ${dayRecord.start_time}–${dayRecord.end_time} on ${formatDate(date)}`
    };
  }

  const [, shiftEnd] = windowMinutes(shift.start_time, shift.end_time);
  if (shiftEnd <= DAY || !nextDayRecord) return null;
  const nextDate = nextDayRecord.date;
  const nextStatus = availabilityStatus(nextDayRecord);
  if (nextStatus === 'unavailable') {
    return { date: nextDate, status: 'unavailable', message: `Marked unavailable on ${formatDate(nextDate)}` };
  }
  if (nextStatus === 'partial') {
    const afterMidnight = { start_time: '00:00', end_time: shift.end_time };
    if (!shiftFitsWindow(afterMidnight, nextDayRecord.start_time, nextDayRecord.end_time)) {
      return {
        date: nextDate,
        status: 'partial',
        message: `Only available ${nextDayRecord.start_time}–${nextDayRecord.end_time} on ${formatDate(nextDate)}`
      };
    }
  }
  return null;
}

module.exports = {
  AVAILABILITY_STATUSES,
  availabilityStatus,
  shiftFitsWindow,
  availabilityConflict
};
