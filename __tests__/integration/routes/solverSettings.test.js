// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const SolverSettings = require('../../../models/SolverSettings');
const { createTestUser, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('AI solver constraint routes', () => {
  test('GET seeds the default rules', async () => {
    const keyWorker = await createTestUser({ role: 'key_worker', email: email('kw') });
    const response = await request(app)
      .get('/api/ai-solver/constraints')
      .set('Authorization', getAuthHeader(keyWorker._id))
      .expect(200);

    const { settings, defaults, locked_rules } = response.body;
    expect(settings.min_rest_hours).toBe(8);
    expect(settings.auto_assignable_roles).toEqual(['support_worker']);
    expect(settings.hours.fulltime.hard_max).toBe(48);
    expect(settings.hours.parttime.hard_max).toBe(20);
    expect(settings.hours.bank.hard_max).toBe(15);
    expect(settings.manual_assign_cap.fulltime_hours).toBe(48);
    expect(settings.manual_assign_cap.approver_roles).toEqual(['admin']);
    expect(settings.consecutive_days_enabled).toBe(true);
    expect(settings.same_shift_limit_enabled).toBe(true);
    expect(settings.max_same_shift_in_a_row).toBe(3);
    expect(defaults).toEqual(SolverSettings.DEFAULTS);
    expect(locked_rules.map((r) => r.key)).toContain('no_double_booking');
  });

  test('admin can update a nested rule without touching the rest', async () => {
    const admin = await createTestUser({ role: 'admin', email: email('admin') });
    const response = await request(app)
      .put('/api/ai-solver/constraints')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ min_rest_hours: 11, hours: { fulltime: { hard_max: 45 } }, _id: 'ignored' })
      .expect(200);

    const { settings } = response.body;
    expect(settings.min_rest_hours).toBe(11);
    expect(settings.hours.fulltime.hard_max).toBe(45);
    expect(settings.hours.fulltime.target_min).toBe(38);
    expect(settings.hours.parttime.hard_max).toBe(20);
  });

  test('invalid values are rejected', async () => {
    const admin = await createTestUser({ role: 'admin', email: email('admin') });
    const auth = getAuthHeader(admin._id);

    await request(app).put('/api/ai-solver/constraints').set('Authorization', auth)
      .send({ min_rest_hours: 30 }).expect(400);
    await request(app).put('/api/ai-solver/constraints').set('Authorization', auth)
      .send({ type_mix: { fulltime_share: 0.8, parttime_share: 0.5 } }).expect(400);
    await request(app).put('/api/ai-solver/constraints').set('Authorization', auth)
      .send({ auto_assignable_roles: [] }).expect(400);

    const settings = await SolverSettings.getSettings();
    expect(settings.min_rest_hours).toBe(8);
  });

  test('reset restores defaults', async () => {
    const admin = await createTestUser({ role: 'admin', email: email('admin') });
    const auth = getAuthHeader(admin._id);
    await request(app).put('/api/ai-solver/constraints').set('Authorization', auth)
      .send({ min_rest_hours: 12, consecutive_days_enabled: false }).expect(200);

    const response = await request(app).post('/api/ai-solver/constraints/reset')
      .set('Authorization', auth).expect(200);
    expect(response.body.settings.min_rest_hours).toBe(8);
    expect(response.body.settings.consecutive_days_enabled).toBe(true);
  });

  test('key workers can read but not change the rules', async () => {
    const keyWorker = await createTestUser({ role: 'key_worker', email: email('kw') });
    const auth = getAuthHeader(keyWorker._id);
    await request(app).put('/api/ai-solver/constraints').set('Authorization', auth)
      .send({ min_rest_hours: 11 }).expect(403);
    await request(app).post('/api/ai-solver/constraints/reset').set('Authorization', auth).expect(403);
  });
});
