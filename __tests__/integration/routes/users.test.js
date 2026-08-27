// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

describe('Users Routes', () => {
  describe('POST /api/users (admin creates a user)', () => {
    test('should create a new user when requested by an admin', async () => {
      const admin = await createTestUser({ role: 'admin', email: `admin${Date.now()}@example.com` });

      const userData = {
        name: 'John Doe',
        email: `john${Date.now()}@example.com`,
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker',
        type: 'fulltime'
      };

      const response = await request(app)
        .post('/api/users')
        .set('Authorization', getAuthHeader(admin._id))
        .send(userData)
        .expect(201);

      expect(response.body.email).toBe(userData.email.toLowerCase());
      expect(response.body.password).toBeUndefined();
    });

    test('should attach home_id to homes array for non-admin users', async () => {
      const admin = await createTestUser({ role: 'admin', email: `admin${Date.now()}@example.com` });
      const home = await createTestHome();

      const userData = {
        name: 'Jane Doe',
        email: `jane${Date.now()}@example.com`,
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker',
        home_id: home._id.toString()
      };

      const response = await request(app)
        .post('/api/users')
        .set('Authorization', getAuthHeader(admin._id))
        .send(userData)
        .expect(201);

      expect(response.body.homes).toHaveLength(1);
      expect(response.body.homes[0].home_id.toString()).toBe(home._id.toString());
    });

    test('should fail if user already exists', async () => {
      const admin = await createTestUser({ role: 'admin', email: `admin${Date.now()}@example.com` });
      const existing = await createTestUser();

      const userData = {
        name: 'Another User',
        email: existing.email,
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker'
      };

      const response = await request(app)
        .post('/api/users')
        .set('Authorization', getAuthHeader(admin._id))
        .send(userData)
        .expect(400);

      expect(response.body.error).toContain('already exists');
    });

    test('should fail with a short password', async () => {
      const admin = await createTestUser({ role: 'admin', email: `admin${Date.now()}@example.com` });

      const response = await request(app)
        .post('/api/users')
        .set('Authorization', getAuthHeader(admin._id))
        .send({
          name: 'Short Pass',
          email: `short${Date.now()}@example.com`,
          phone: '+1234567890',
          password: 'short',
          role: 'support_worker'
        })
        .expect(400);

      expect(response.body.error).toContain('at least 8 characters');
    });

    test('should forbid non-admins from creating users', async () => {
      const staff = await createTestUser({ role: 'support_worker', email: `staff${Date.now()}@example.com` });

      const response = await request(app)
        .post('/api/users')
        .set('Authorization', getAuthHeader(staff._id))
        .send({
          name: 'Nope',
          email: `nope${Date.now()}@example.com`,
          phone: '+1234567890',
          password: 'Password123',
          role: 'support_worker'
        })
        .expect(403);

      expect(response.body).toHaveProperty('error');
    });

    test('should require authentication', async () => {
      await request(app)
        .post('/api/users')
        .send({
          name: 'Anon',
          email: `anon${Date.now()}@example.com`,
          phone: '+1234567890',
          password: 'Password123',
          role: 'support_worker'
        })
        .expect(401);
    });
  });
});
