// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const { setSleepInHours, DEFAULT_SLEEP_IN_HOURS } = require('../../../utils/shiftHours');
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

describe('sleep-in hours', () => {
  let admin, worker, home, service;

  beforeEach(async () => {
    home = await createTestHome({ name: 'Home A' });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    worker = await createTestUser({ email: email('sw'), homes: [{ home_id: home._id }] });
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 8, max_staff_count: 5 });
    // 20:00 → 08:00 sleep-in: 12h rostered.
    await createTestShift({
      home_id: home._id,
      service_id: service._id,
      date: DATE,
      start_time: '20:00',
      end_time: '08:00',
      shift_type: 'night-sleep',
      assigned_staff: [{ user_id: worker._id }],
    });
  });

  afterEach(() => setSleepInHours(DEFAULT_SLEEP_IN_HOURS));

  const payrollRow = async () => {
    const res = await request(app)
      .get('/api/payroll')
      .set('Authorization', getAuthHeader(admin._id))
      .query({ start_date: DATE, end_date: DATE, home_id: home._id.toString(), mode: 'draft' })
      .expect(200);
    return res.body.records.find((r) => r.user_id === worker._id.toString());
  };

  test('by default the last 9 hours are sleep and the rest is regular pay', async () => {
    const row = await payrollRow();
    expect(row.night_hours).toBe(3);
    expect(row.sleep_night_shifts).toBe(1);
    expect(row.sleep_in_pay).toBe(55);
  });

  test('admins can change the sleep length, and payroll and clients follow it', async () => {
    await request(app)
      .put('/api/ai-solver/constraints')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ sleep_in: { sleep_hours: 8 } })
      .expect(200);

    const row = await payrollRow();
    expect(row.night_hours).toBe(4);
    expect(row.sleep_in_pay).toBe(55);

    const res = await request(app)
      .get('/api/ai-solver/sleep-in')
      .set('Authorization', getAuthHeader(worker._id))
      .expect(200);
    expect(res.body.sleep_hours).toBe(8);
  });

  test('non-admins cannot change it and out-of-range values are rejected', async () => {
    await request(app)
      .put('/api/ai-solver/constraints')
      .set('Authorization', getAuthHeader(worker._id))
      .send({ sleep_in: { sleep_hours: 2 } })
      .expect(403);
    await request(app)
      .put('/api/ai-solver/constraints')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ sleep_in: { sleep_hours: 30 } })
      .expect(400);
  });
});
