// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

jest.mock('../../../services/pushService', () => ({ sendPushToUser: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const app = require('../../../server');
const Message = require('../../../models/Message');
const Shift = require('../../../models/Shift');
const User = require('../../../models/User');
const { flushShiftChangeNotifications } = require('../../../services/shiftChangeNotifications');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;
const WEEK = '2030-03-04'; // a Monday
const NEXT_WEEK = '2030-03-11';

describe('POST /api/shifts/duplicate-week', () => {
  let admin, worker, colleague, home, service;

  const makeShift = (overrides = {}) =>
    createTestShift({
      home_id: home._id,
      service_id: service._id,
      date: WEEK,
      start_time: '08:00',
      end_time: '20:00',
      shift_type: 'day',
      required_staff_count: 2,
      ...overrides,
    });

  const duplicate = (user = admin, body = {}) =>
    request(app)
      .post('/api/shifts/duplicate-week')
      .set('Authorization', getAuthHeader(user._id))
      .send({ home_id: String(home._id), week_start: WEEK, ...body });

  const nextWeekShifts = () => Shift.find({ home_id: home._id, date: { $gte: NEXT_WEEK } }).sort({ date: 1 });

  beforeEach(async () => {
    await flushShiftChangeNotifications();
    home = await createTestHome({ name: 'Oak House' });
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 8, max_staff_count: 5 });
    admin = await createTestUser({ email: email('admin'), role: 'admin' });
    worker = await createTestUser({ email: email('worker'), role: 'support_worker', homes: [{ home_id: home._id }] });
    colleague = await createTestUser({ email: email('colleague'), role: 'support_worker', homes: [{ home_id: home._id }] });
  });

  test('copies allocated shifts and their staff seven days on, leaving unallocated shifts behind', async () => {
    await makeShift({ notes: 'Handover at 08:00', assigned_staff: [{ user_id: worker._id }, { user_id: colleague._id }] });
    await makeShift({ date: '2030-03-05', start_time: '09:00', end_time: '17:00' });

    const res = await duplicate().expect(200);

    expect(res.body).toMatchObject({ target_week_start: NEXT_WEEK, source_shifts: 1, shifts_created: 1, assignments_copied: 2, skipped: [] });
    const [copy, ...rest] = await nextWeekShifts();
    expect(rest).toHaveLength(0);
    expect(copy).toMatchObject({ date: NEXT_WEEK, start_time: '08:00', end_time: '20:00', shift_type: 'day', required_staff_count: 2, notes: 'Handover at 08:00' });
    expect(copy.assigned_staff.map((a) => String(a.user_id)).sort()).toEqual([String(worker._id), String(colleague._id)].sort());
  });

  test('does not carry over attendance or past approvals', async () => {
    await makeShift({
      assigned_staff: [{
        user_id: worker._id,
        attendance_status: 'clocked_out',
        clock_in_time: new Date('2030-03-04T08:00:00Z'),
        clock_out_time: new Date('2030-03-04T20:00:00Z'),
        rest_exception_status: 'confirmed',
        hours_cap_exception_status: 'confirmed',
      }],
    });

    await duplicate().expect(200);

    const [{ assigned_staff: [assignment] }] = await nextWeekShifts();
    expect(assignment.attendance_status).toBe('not_started');
    expect(assignment.clock_in_time).toBeNull();
    expect(assignment.rest_exception_status).toBe('none');
    expect(assignment.hours_cap_exception_status).toBe('none');
  });

  test('fills a matching shift already in next week instead of doubling it', async () => {
    await makeShift({ assigned_staff: [{ user_id: worker._id }] });
    await makeShift({ date: NEXT_WEEK });

    const res = await duplicate().expect(200);

    expect(res.body).toMatchObject({ shifts_created: 0, shifts_updated: 1, assignments_copied: 1 });
    const shifts = await nextWeekShifts();
    expect(shifts).toHaveLength(1);
    expect(String(shifts[0].assigned_staff[0].user_id)).toBe(String(worker._id));
  });

  test('running it twice changes nothing the second time', async () => {
    await makeShift({ assigned_staff: [{ user_id: worker._id }] });

    await duplicate().expect(200);
    const res = await duplicate().expect(200);

    expect(res.body).toMatchObject({ shifts_created: 0, shifts_updated: 0, assignments_copied: 0, skipped: [] });
    const shifts = await nextWeekShifts();
    expect(shifts).toHaveLength(1);
    expect(shifts[0].assigned_staff).toHaveLength(1);
  });

  test('leaves a double-booked person off the copy and reports them, keeping everyone else', async () => {
    await makeShift({ assigned_staff: [{ user_id: worker._id }, { user_id: colleague._id }] });
    await makeShift({ date: NEXT_WEEK, start_time: '10:00', end_time: '14:00', assigned_staff: [{ user_id: worker._id }] });

    const res = await duplicate().expect(200);

    expect(res.body.assignments_copied).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0]).toMatchObject({ date: NEXT_WEEK, staff_name: worker.name });
    expect(res.body.skipped[0].reason).toContain('overlapping');
    const copy = await Shift.findOne({ home_id: home._id, date: NEXT_WEEK, start_time: '08:00' });
    expect(copy.assigned_staff.map((a) => String(a.user_id))).toEqual([String(colleague._id)]);
  });

  test('does not override rules for an admin: weekly cap breaches are reported', async () => {
    const fulltime = await createTestUser({ email: email('fulltime'), role: 'support_worker', type: 'fulltime', homes: [{ home_id: home._id }] });
    const dates = ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08'];
    for (const date of dates) {
      await makeShift({ date, assigned_staff: [{ user_id: fulltime._id }] });
    }

    const res = await duplicate().expect(200);

    expect(res.body.skipped.some((s) => s.staff_name === fulltime.name && /weekly hours/i.test(s.reason))).toBe(true);
    const copied = await Shift.countDocuments({ date: { $gte: NEXT_WEEK }, 'assigned_staff.user_id': fulltime._id });
    expect(copied).toBeLessThan(dates.length);
  });

  test('skips staff who are no longer active', async () => {
    await makeShift({ assigned_staff: [{ user_id: worker._id }] });
    await User.updateOne({ _id: worker._id }, { is_active: false });

    const res = await duplicate().expect(200);

    expect(res.body.assignments_copied).toBe(0);
    expect(res.body.skipped[0]).toMatchObject({ staff_name: worker.name });
  });

  test('skips shifts whose copy would already have started', async () => {
    await makeShift({ date: '2020-03-02', assigned_staff: [{ user_id: worker._id }] });

    const res = await duplicate(admin, { week_start: '2020-03-02' }).expect(200);

    expect(res.body).toMatchObject({ source_shifts: 1, shifts_created: 0, assignments_copied: 0 });
    expect(res.body.skipped[0].reason).toContain('already started');
    expect(await Shift.countDocuments({ date: '2020-03-09' })).toBe(0);
  });

  test('tells each copied staff member once, in one summary', async () => {
    await makeShift({ assigned_staff: [{ user_id: worker._id }] });
    await makeShift({ date: '2030-03-05', assigned_staff: [{ user_id: worker._id }] });

    await duplicate().expect(200);
    await flushShiftChangeNotifications();

    const messages = await Message.find({ to_user_id: worker._id });
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('Assigned: Mon 11 Mar');
    expect(messages[0].body).toContain('Assigned: Tue 12 Mar');
  });

  test('rejects a week_start that is not a Monday', async () => {
    await duplicate(admin, { week_start: '2030-03-05' }).expect(400);
    await duplicate(admin, { week_start: { $gte: '' } }).expect(400);
  });

  test('is refused for support workers', async () => {
    await duplicate(worker).expect(403);
  });
});
