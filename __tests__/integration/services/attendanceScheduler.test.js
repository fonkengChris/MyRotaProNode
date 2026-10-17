process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Shift = require('../../../models/Shift');
const Message = require('../../../models/Message');
const { runAttendanceCheck } = require('../../../services/attendanceScheduler');
const { APP_TIMEZONE, shiftStartDate } = require('../../../utils/shiftTime');
const { createTestUser, createTestHome } = require('../../../tests/utils/testHelpers');

// Build a shift that started `minutesAgo` minutes ago (in APP_TIMEZONE) lasting 8h.
async function makeLateShift({ home, worker, minutesAgo, hours = 8, extra = {} }) {
  const start = moment.tz(APP_TIMEZONE).subtract(minutesAgo, 'minutes');
  const end = start.clone().add(hours, 'hours');
  return Shift.create({
    home_id: home._id,
    service_id: new mongoose.Types.ObjectId(),
    date: start.format('YYYY-MM-DD'),
    start_time: start.format('HH:mm'),
    end_time: end.format('HH:mm'),
    shift_type: 'day',
    required_staff_count: 1,
    assigned_staff: [{ user_id: worker._id }],
    ...extra,
  });
}

describe('attendanceScheduler.runAttendanceCheck', () => {
  let home, worker, manager, admin;

  beforeEach(async () => {
    home = await createTestHome();
    worker = await createTestUser({
      email: `worker${Date.now()}@example.com`,
      role: 'support_worker',
      homes: [{ home_id: home._id }],
    });
    manager = await createTestUser({
      email: `manager${Date.now()}@example.com`,
      role: 'key_worker',
      homes: [{ home_id: home._id }],
    });
    admin = await createTestUser({
      email: `admin${Date.now()}@example.com`,
      role: 'admin',
    });
  });

  test('sends only a staff reminder at 6 minutes late', async () => {
    const shift = await makeLateShift({ home, worker, minutesAgo: 6 });

    await runAttendanceCheck();

    const toWorker = await Message.find({ to_user_id: worker._id });
    const toManager = await Message.find({ to_user_id: manager._id });
    expect(toWorker).toHaveLength(1); // reminder
    expect(toManager).toHaveLength(0); // no escalation yet

    const updated = await Shift.findById(shift._id);
    expect(updated.assigned_staff[0].clock_in_reminder_sent_at).toBeTruthy();
    expect(updated.assigned_staff[0].clock_in_escalation_sent_at).toBeFalsy();
  });

  test('escalates to managers + admins at 16 minutes late, exactly once', async () => {
    await makeLateShift({ home, worker, minutesAgo: 16 });

    await runAttendanceCheck();

    expect(await Message.find({ to_user_id: worker._id })).toHaveLength(1); // reminder
    expect(await Message.find({ to_user_id: manager._id })).toHaveLength(1); // escalation
    expect(await Message.find({ to_user_id: admin._id })).toHaveLength(1); // escalation

    // Second tick must be idempotent (no duplicate notifications).
    await runAttendanceCheck();
    expect(await Message.find({ to_user_id: worker._id })).toHaveLength(1);
    expect(await Message.find({ to_user_id: manager._id })).toHaveLength(1);
    expect(await Message.find({ to_user_id: admin._id })).toHaveLength(1);
  });

  test('skips assignments still awaiting admin approval', async () => {
    const shift = await makeLateShift({
      home, worker, minutesAgo: 16,
      extra: { assigned_staff: [{ user_id: worker._id, hours_cap_exception_status: 'pending' }] },
    });

    await runAttendanceCheck();

    expect(await Message.find({ to_user_id: worker._id })).toHaveLength(0);
    expect(await Message.find({ to_user_id: manager._id })).toHaveLength(0);
    const updated = await Shift.findById(shift._id);
    expect(updated.assigned_staff[0].attendance_status).toBe('not_started');
  });

  test('does not notify once the staff member has clocked in', async () => {
    const shift = await makeLateShift({ home, worker, minutesAgo: 16 });
    shift.assigned_staff[0].clock_in_time = new Date();
    shift.assigned_staff[0].attendance_status = 'clocked_in';
    await shift.save();

    await runAttendanceCheck();

    expect(await Message.countDocuments({})).toBe(0);
  });

  test('a 1-to-1 covered by the background shift gets no reminders and is never missed', async () => {
    const background = await makeLateShift({ home, worker, minutesAgo: 60 });
    background.assigned_staff[0].clock_in_time = new Date();
    background.assigned_staff[0].attendance_status = 'clocked_in';
    await background.save();

    const oneToOne = await makeLateShift({
      home,
      worker,
      minutesAgo: 16,
      hours: 2,
      extra: { shift_type: 'one_to_one', service_user_id: new mongoose.Types.ObjectId() },
    });

    await runAttendanceCheck();
    expect(await Message.countDocuments({})).toBe(0);
    const updated = await Shift.findById(oneToOne._id);
    expect(updated.assigned_staff[0].attendance_status).toBe('not_started');
  });

  test('an uncovered 1-to-1 is reminded like any shift', async () => {
    await makeLateShift({
      home,
      worker,
      minutesAgo: 6,
      hours: 2,
      extra: { shift_type: 'one_to_one', service_user_id: new mongoose.Types.ObjectId() },
    });

    await runAttendanceCheck();
    expect(await Message.find({ to_user_id: worker._id })).toHaveLength(1);
  });

  describe('clock-out grace period', () => {
    // Shift that ended `minutesAgo` minutes ago, with the worker clocked in at its start.
    async function makeOverrunShift(minutesAgo) {
      const shift = await makeLateShift({ home, worker, minutesAgo: 8 * 60 + minutesAgo });
      shift.assigned_staff[0].clock_in_time = shiftStartDate(shift);
      shift.assigned_staff[0].attendance_status = 'clocked_in';
      await shift.save();
      return shift;
    }

    test('no admin notice within the 15-minute grace period', async () => {
      await makeOverrunShift(10);
      await runAttendanceCheck();
      expect(await Message.find({ to_user_id: admin._id })).toHaveLength(0);
    });

    test('notifies admins only (once) when still clocked in 16 minutes after end', async () => {
      const shift = await makeOverrunShift(16);

      await runAttendanceCheck();
      await runAttendanceCheck();

      expect(await Message.find({ to_user_id: admin._id })).toHaveLength(1);
      expect(await Message.find({ to_user_id: manager._id })).toHaveLength(0);
      const updated = await Shift.findById(shift._id);
      expect(updated.assigned_staff[0].clock_out_escalation_sent_at).toBeTruthy();
    });

    test('no admin notice once the worker has clocked out', async () => {
      const shift = await makeOverrunShift(20);
      shift.assigned_staff[0].clock_out_time = new Date();
      shift.assigned_staff[0].attendance_status = 'clocked_out';
      await shift.save();

      await runAttendanceCheck();
      expect(await Message.find({ to_user_id: admin._id })).toHaveLength(0);
    });
  });
});
