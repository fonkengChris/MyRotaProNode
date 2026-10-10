// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const ServiceUser = require('../../../models/ServiceUser');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('Service Users Routes', () => {
  let admin, keyWorker, homeA, homeB;

  beforeEach(async () => {
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    // Key worker is deliberately NOT attached to any home.
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw') });
    homeA = await createTestHome({ name: 'Home A' });
    homeB = await createTestHome({ name: 'Home B' });
  });

  describe('admin CRUD', () => {
    test('admin can create, update and delete a service user', async () => {
      const created = await request(app)
        .post('/api/service-users')
        .set('Authorization', getAuthHeader(admin._id))
        .send({ name: 'Alex', home_id: homeA._id.toString(), key_worker_ids: [keyWorker._id.toString()] })
        .expect(201);

      expect(created.body.name).toBe('Alex');
      expect(created.body.home_id.name).toBe('Home A');
      expect(created.body.key_worker_ids[0].name).toBe(keyWorker.name);

      const updated = await request(app)
        .put(`/api/service-users/${created.body._id}`)
        .set('Authorization', getAuthHeader(admin._id))
        .send({ home_id: homeB._id.toString(), notes: 'Moved' })
        .expect(200);
      expect(updated.body.home_id.name).toBe('Home B');
      expect(updated.body.notes).toBe('Moved');

      await request(app)
        .delete(`/api/service-users/${created.body._id}`)
        .set('Authorization', getAuthHeader(admin._id))
        .expect(200);
      expect(await ServiceUser.countDocuments()).toBe(0);
    });

    test('rejects key_worker_ids that are not key workers', async () => {
      const supportWorker = await createTestUser({ email: email('sw') });
      const response = await request(app)
        .post('/api/service-users')
        .set('Authorization', getAuthHeader(admin._id))
        .send({ name: 'Alex', home_id: homeA._id.toString(), key_worker_ids: [supportWorker._id.toString()] })
        .expect(400);
      expect(response.body.error).toContain('key worker');
    });

    test('saves allocated 1:1 hours and rejects out-of-range values', async () => {
      const created = await request(app)
        .post('/api/service-users')
        .set('Authorization', getAuthHeader(admin._id))
        .send({ name: 'Alex', home_id: homeA._id.toString(), one_to_one_hours_per_week: 12.5 })
        .expect(201);
      expect(created.body.one_to_one_hours_per_week).toBe(12.5);

      const updated = await request(app)
        .put(`/api/service-users/${created.body._id}`)
        .set('Authorization', getAuthHeader(admin._id))
        .send({ one_to_one_hours_per_week: 20 })
        .expect(200);
      expect(updated.body.one_to_one_hours_per_week).toBe(20);

      await request(app)
        .put(`/api/service-users/${created.body._id}`)
        .set('Authorization', getAuthHeader(admin._id))
        .send({ one_to_one_hours_per_week: 200 })
        .expect(400);
      await request(app)
        .post('/api/service-users')
        .set('Authorization', getAuthHeader(admin._id))
        .send({ name: 'Blake', home_id: homeA._id.toString(), one_to_one_hours_per_week: -1 })
        .expect(400);
    });

    test('non-admins cannot create service users', async () => {
      await request(app)
        .post('/api/service-users')
        .set('Authorization', getAuthHeader(keyWorker._id))
        .send({ name: 'Alex', home_id: homeA._id.toString() })
        .expect(403);
    });
  });

  describe('key worker access', () => {
    beforeEach(async () => {
      await ServiceUser.create({ name: 'Alex', home_id: homeA._id, key_worker_ids: [keyWorker._id] });
      await ServiceUser.create({ name: 'Blake', home_id: homeB._id, key_worker_ids: [] });
    });

    test('key worker only sees the service users they support', async () => {
      const response = await request(app)
        .get('/api/service-users')
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(200);
      expect(response.body.map(su => su.name)).toEqual(['Alex']);
    });

    test('support workers cannot list service users', async () => {
      const supportWorker = await createTestUser({ email: email('sw') });
      await request(app)
        .get('/api/service-users')
        .set('Authorization', getAuthHeader(supportWorker._id))
        .expect(403);
    });

    test('my-caseload returns the home, service users and staff', async () => {
      const staff = await createTestUser({
        email: email('staff'),
        name: 'Staff In A',
        homes: [{ home_id: homeA._id, is_default: true }]
      });
      await createTestUser({ email: email('staffb'), homes: [{ home_id: homeB._id, is_default: true }] });

      const response = await request(app)
        .get('/api/service-users/my-caseload')
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].home.name).toBe('Home A');
      expect(response.body[0].service_users.map(su => su.name)).toEqual(['Alex']);
      expect(response.body[0].staff.map(s => s._id)).toEqual([staff._id.toString()]);
    });

    test("key worker can view their service user's home and its staff, but not other homes", async () => {
      await createTestUser({ email: email('staff'), homes: [{ home_id: homeA._id, is_default: true }] });

      await request(app)
        .get(`/api/homes/${homeA._id}`)
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(200);
      await request(app)
        .get(`/api/homes/${homeB._id}`)
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(403);

      const staffA = await request(app)
        .get(`/api/users?home_id=${homeA._id}`)
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(200);
      expect(staffA.body).toHaveLength(1);
      await request(app)
        .get(`/api/users?home_id=${homeB._id}`)
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(403);

      const homes = await request(app)
        .get('/api/homes')
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(200);
      expect(homes.body.map(h => h.name)).toEqual(['Home A']);
    });

    test('deactivating the service user removes the derived home access', async () => {
      await ServiceUser.updateMany({ name: 'Alex' }, { is_active: false });
      await request(app)
        .get(`/api/homes/${homeA._id}`)
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(403);
    });

    test('/auth/me reports homes reached through service users', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', getAuthHeader(keyWorker._id))
        .expect(200);
      expect(response.body.user.service_user_home_ids).toEqual([homeA._id.toString()]);
    });
  });
});
