// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const User = require('../../../models/User');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;
const DATE = '2026-01-13';

describe('per-staff hourly rate', () => {
  let admin, keyWorker, worker, home, service;

  beforeEach(async () => {
    home = await createTestHome({ name: 'Home A' });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    worker = await createTestUser({ email: email('sw'), homes: [{ home_id: home._id }] });
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 8, max_staff_count: 5 });
  });

  const rateOf = async (user) => (await User.findById(user._id).select('+hourly_rate')).hourly_rate;

  test('new users default to their role rate', async () => {
    expect(await rateOf(worker)).toBe(12.71);
    expect(await rateOf(keyWorker)).toBe(15);
  });

  test('admins can set a rate on create and update, and see it', async () => {
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ name: 'New', email: email('new'), phone: '+447123456789', password: 'password123', role: 'support_worker', hourly_rate: 13.5 })
      .expect(201);
    expect(created.body.hourly_rate).toBe(13.5);

    const updated = await request(app)
      .put(`/api/users/${worker._id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ hourly_rate: 16.25 })
      .expect(200);
    expect(updated.body.hourly_rate).toBe(16.25);

    const list = await request(app).get('/api/users').set('Authorization', getAuthHeader(admin._id)).expect(200);
    expect(list.body.find((u) => u.id === worker._id.toString()).hourly_rate).toBe(16.25);
  });

  test('rates above the cap are rejected', async () => {
    await request(app)
      .put(`/api/users/${worker._id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ hourly_rate: 500 })
      .expect(400);
    expect(await rateOf(worker)).toBe(12.71);
  });

  test('non-admins can neither see nor change pay', async () => {
    await request(app)
      .put(`/api/users/${worker._id}`)
      .set('Authorization', getAuthHeader(keyWorker._id))
      .send({ hourly_rate: 40 })
      .expect(200);
    await request(app)
      .put(`/api/users/${worker._id}`)
      .set('Authorization', getAuthHeader(worker._id))
      .send({ hourly_rate: 40 })
      .expect(200);
    expect(await rateOf(worker)).toBe(12.71);

    const list = await request(app).get('/api/users').set('Authorization', getAuthHeader(keyWorker._id)).expect(200);
    expect(list.body.every((u) => u.hourly_rate === undefined)).toBe(true);
  });

  test('payroll pays each staff member at their own rate', async () => {
    await User.updateOne({ _id: worker._id }, { hourly_rate: 20 });
    await createTestShift({
      home_id: home._id,
      service_id: service._id,
      date: DATE,
      start_time: '09:00',
      end_time: '11:00',
      assigned_staff: [{ user_id: worker._id }],
    });

    const res = await request(app)
      .get('/api/payroll')
      .set('Authorization', getAuthHeader(admin._id))
      .query({ start_date: DATE, end_date: DATE, home_id: home._id.toString(), mode: 'draft' })
      .expect(200);
    const row = res.body.records.find((r) => r.user_id === worker._id.toString());
    expect(row.hourly_rate).toBe(20);
    expect(row.paid_hours).toBeGreaterThan(0);
    expect(row.gross_pay).toBeCloseTo(row.paid_hours * 20, 2);
  });
});
