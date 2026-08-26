process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Shift = require('../../../models/Shift');
const Message = require('../../../models/Message');
const { runAttendanceCheck } = require('../../../services/attendanceScheduler');
const { APP_TIMEZONE } = require('../../../utils/shiftTime');
const { createTestUser, createTestHome } = require('../../../tests/utils/testHelpers');

// Build a shift that started `minutesAgo` minutes ago (in APP_TIMEZONE) lasting 8h.
async function makeLateShift({ home, worker, minutesAgo }) {
  const start = moment.tz(APP_TIMEZONE).subtract(minutesAgo, 'minutes');
  const end = start.clone().add(8, 'hours');
  return Shift.create({
    home_id: home._id,
    service_id: new mongoose.Types.ObjectId(),
    date: start.format('YYYY-MM-DD'),
    start_time: start.format('HH:mm'),
    end_time: end.format('HH:mm'),
    shift_type: 'day',
    required_staff_count: 1,
    assigned_staff: [{ user_id: worker._id }],
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

  test('does not notify once the staff member has clocked in', async () => {
    const shift = await makeLateShift({ home, worker, minutesAgo: 16 });
    shift.assigned_staff[0].clock_in_time = new Date();
    shift.assigned_staff[0].attendance_status = 'clocked_in';
    await shift.save();

    await runAttendanceCheck();

    expect(await Message.countDocuments({})).toBe(0);
  });
});
