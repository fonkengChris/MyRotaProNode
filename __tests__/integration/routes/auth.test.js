// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const User = require('../../../models/User');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

describe('Auth Routes', () => {
  describe('POST /api/auth/register', () => {
    test('should register a new user successfully', async () => {
      const userData = {
        name: 'John Doe',
        email: `john${Date.now()}@example.com`,
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker',
        type: 'fulltime'
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('user');
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('permissions');
      expect(response.body.user.email).toBe(userData.email.toLowerCase());
      expect(response.body.user.password).toBeUndefined();
    });

    test('should fail with validation errors', async () => {
      const userData = {
        name: 'A', // Too short
        email: 'invalid-email',
        password: 'short' // Too short
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('details');
    });

    test('should fail if user already exists', async () => {
      const user = await createTestUser();

      const userData = {
        name: 'Another User',
        email: user.email,
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker'
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.error).toContain('already exists');
    });

    test('should add home_id to homes array for non-admin users', async () => {
      const home = await createTestHome();

      const userData = {
        name: 'John Doe',
        email: `john${Date.now()}@example.com`,
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker',
        home_id: home._id.toString()
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body.user.homes).toHaveLength(1);
      expect(response.body.user.homes[0].home_id.toString()).toBe(home._id.toString());
    });
  });

  describe('POST /api/auth/login', () => {
    test('should login successfully with valid credentials', async () => {
      const password = 'TestPassword123';
      const user = await createTestUser({ password });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: user.email,
          password: password
        })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('user');
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('permissions');
      expect(response.body.user.email).toBe(user.email);
    });

    test('should fail with invalid email', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'Password123'
        })
        .expect(400);

      expect(response.body.error).toContain('Invalid credentials');
    });

    test('should fail with invalid password', async () => {
      const user = await createTestUser({ password: 'TestPassword123' });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: user.email,
          password: 'WrongPassword'
        })
        .expect(400);

      expect(response.body.error).toContain('Invalid credentials');
    });

    test('should fail if account is deactivated', async () => {
      const user = await createTestUser({ password: 'TestPassword123', is_active: false });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: user.email,
          password: 'TestPassword123'
        })
        .expect(400);

      expect(response.body.error).toContain('deactivated');
    });

    test('should fail with validation errors', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'invalid-email',
          password: ''
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('details');
    });
  });

  describe('GET /api/auth/me', () => {
    test('should get current user info with valid token', async () => {
      const user = await createTestUser();

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', getAuthHeader(user._id))
        .expect(200);

      expect(response.body).toHaveProperty('user');
      expect(response.body).toHaveProperty('permissions');
      expect(response.body.user.email).toBe(user.email);
    });

    test('should fail without token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .expect(401);

      expect(response.body.error).toContain('No token provided');
    });

    test('should fail with invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.error).toContain('Invalid token');
    });

    test('should fail with expired token', async () => {
      const jwt = require('jsonwebtoken');
      const expiredToken = jwt.sign(
        { userId: 'some-id' },
        process.env.JWT_SECRET,
        { expiresIn: '-1h' }
      );

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body.error).toContain('expired');
    });
  });

  describe('POST /api/auth/refresh', () => {
    test('should refresh token successfully', async () => {
      const user = await createTestUser();

      const response = await request(app)
        .post('/api/auth/refresh')
        .set('Authorization', getAuthHeader(user._id))
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('token');
      expect(response.body.token).toBeDefined();
    });

    test('should fail without token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .expect(401);

      expect(response.body.error).toContain('No token provided');
    });
  });

  describe('POST /api/auth/change-password', () => {
    test('should change password successfully', async () => {
      const oldPassword = 'OldPassword123';
      const newPassword = 'NewPassword123';
      const user = await createTestUser({ password: oldPassword });

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', getAuthHeader(user._id))
        .send({
          currentPassword: oldPassword,
          newPassword: newPassword
        })
        .expect(200);

      expect(response.body.message).toContain('successfully');

      // Verify password was changed
      const updatedUser = await User.findById(user._id).select('+password');
      const isValid = await updatedUser.comparePassword(newPassword);
      expect(isValid).toBe(true);
    });

    test('should fail with incorrect current password', async () => {
      const user = await createTestUser({ password: 'OldPassword123' });

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', getAuthHeader(user._id))
        .send({
          currentPassword: 'WrongPassword',
          newPassword: 'NewPassword123'
        })
        .expect(400);

      expect(response.body.error).toContain('incorrect');
    });

    test('should fail with validation errors', async () => {
      const user = await createTestUser();

      const response = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', getAuthHeader(user._id))
        .send({
          currentPassword: '',
          newPassword: 'short'
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('details');
    });
  });

  describe('POST /api/auth/logout', () => {
    test('should logout successfully', async () => {
      const user = await createTestUser();

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', getAuthHeader(user._id))
        .expect(200);

      expect(response.body.message).toContain('successful');
    });

    test('should fail without token', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .expect(401);

      expect(response.body.error).toContain('No token provided');
    });
  });
});

