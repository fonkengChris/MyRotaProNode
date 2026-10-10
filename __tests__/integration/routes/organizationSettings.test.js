// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const OrganizationSettings = require('../../../models/OrganizationSettings');
const { createTestUser, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('Organization Settings Routes', () => {
  test('GET seeds key-worker task prompts on first access', async () => {
    const user = await createTestUser({ email: email('sw') });
    const response = await request(app)
      .get('/api/organization-settings')
      .set('Authorization', getAuthHeader(user._id))
      .expect(200);

    const defaults = OrganizationSettings.DEFAULTS.key_worker_tasks;
    expect(response.body.key_worker_tasks.daily).toEqual(defaults.daily);
    expect(response.body.key_worker_tasks.weekly).toEqual(defaults.weekly);
    expect(response.body.key_worker_tasks.monthly).toEqual(defaults.monthly);
  });

  test('GET backfills key-worker prompts on a settings doc that predates them', async () => {
    // Insert raw, bypassing schema defaults, to mimic an older stored document.
    await OrganizationSettings.collection.insertOne({ company_contacts: [], emergency_contacts: [], shift_tips: { core: ['x'] } });
    const user = await createTestUser({ email: email('sw') });

    const response = await request(app)
      .get('/api/organization-settings')
      .set('Authorization', getAuthHeader(user._id))
      .expect(200);

    expect(response.body.shift_tips.core).toEqual(['x']);
    expect(response.body.key_worker_tasks.weekly).toEqual(OrganizationSettings.DEFAULTS.key_worker_tasks.weekly);
  });

  test('admin can update key-worker prompts, and a cleared section stays cleared', async () => {
    const admin = await createTestUser({ role: 'admin', email: email('admin') });

    await request(app)
      .put('/api/organization-settings')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ key_worker_tasks: { weekly: ['Audit staff files'], monthly: [] } })
      .expect(200);

    const response = await request(app)
      .get('/api/organization-settings')
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);

    expect(response.body.key_worker_tasks.weekly).toEqual(['Audit staff files']);
    expect(response.body.key_worker_tasks.monthly).toEqual([]);
    expect(response.body.key_worker_tasks.daily).toEqual(OrganizationSettings.DEFAULTS.key_worker_tasks.daily);
  });

  test('non-admins cannot update settings', async () => {
    const keyWorker = await createTestUser({ role: 'key_worker', email: email('kw') });
    await request(app)
      .put('/api/organization-settings')
      .set('Authorization', getAuthHeader(keyWorker._id))
      .send({ key_worker_tasks: { daily: [] } })
      .expect(403);
  });
});
