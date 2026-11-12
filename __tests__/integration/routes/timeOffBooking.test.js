// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const TimeOffRequest = require('../../../models/TimeOffRequest');
const Availability = require('../../../models/Availability');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('Admins book leave directly (POST /api/timeoff/book)', () => {
  let admin, keyWorker, home, staff;

  beforeEach(async () => {
    home = await createTestHome();
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    staff = [];
    for (let i = 0; i < 4; i++) {
      staff.push(await createTestUser({ email: email(`sw${i}`), homes: [{ home_id: home._id }] }));
    }
  });

  const book = (as, body) =>
    request(app)
      .post('/api/timeoff/book')
      .set('Authorization', getAuthHeader(as._id))
      .send({ reason: 'Booked by admin', request_type: 'annual_leave', ...body });

  test('creates approved leave and marks the days unavailable', async () => {
    const res = await book(admin, { user_id: staff[0]._id.toString(), start_date: '2030-09-01', end_date: '2030-09-02' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');
    expect(res.body.approved_by._id).toBe(admin._id.toString());

    const days = await Availability.find({ user_id: staff[0]._id }).sort('date');
    expect(days.map((d) => d.date)).toEqual(['2030-09-01', '2030-09-02']);
    expect(days.every((d) => d.status === 'unavailable')).toBe(true);
  });

  test('past dates can be booked (e.g. recording sickness)', async () => {
    const res = await book(admin, {
      user_id: staff[0]._id.toString(), start_date: '2020-01-06', end_date: '2020-01-06', request_type: 'sick_leave'
    });
    expect(res.status).toBe(201);
  });

  test('key workers and staff cannot book', async () => {
    const body = { user_id: staff[0]._id.toString(), start_date: '2030-09-01', end_date: '2030-09-01' };
    await book(keyWorker, body).expect(403);
    await book(staff[1], body).expect(403);
    expect(await TimeOffRequest.countDocuments()).toBe(0);
  });

  test('over the home leave limit needs an explicit override', async () => {
    for (const s of staff.slice(0, 3)) {
      await TimeOffRequest.create({
        user_id: s._id, start_date: '2030-10-01', end_date: '2030-10-01', reason: 'Holiday', request_type: 'annual_leave', status: 'approved'
      });
    }
    const body = { user_id: staff[3]._id.toString(), start_date: '2030-10-01', end_date: '2030-10-01' };

    const blocked = await book(admin, body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('HOME_LEAVE_LIMIT');

    const ok = await book(admin, { ...body, override_home_leave_limit: true });
    expect(ok.status).toBe(201);
    const saved = await TimeOffRequest.findById(ok.body._id);
    expect(saved.home_leave_limit_override.approved_by.toString()).toBe(admin._id.toString());
  });

  test('rejects bad input', async () => {
    await book(admin, { user_id: staff[0]._id.toString(), start_date: '2030-09-05', end_date: '2030-09-01' }).expect(400);
    await book(admin, { start_date: '2030-09-01', end_date: '2030-09-01' }).expect(400);
  });
});
