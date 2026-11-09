// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';
process.env.FRONTEND_URL = 'https://app.example.com/';

jest.mock('../../../services/emailService', () => ({
  isEmailConfigured: jest.fn(() => true),
  sendEmail: jest.fn(async () => true),
  sendPasswordResetEmail: jest.fn(async () => true)
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../../server');
const User = require('../../../models/User');
const { sendPasswordResetEmail } = require('../../../services/emailService');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

// A token issued a minute ago, i.e. before any password change made in the test.
const oldAuthHeader = (userId) => `Bearer ${jwt.sign(
  { userId, iat: Math.floor(Date.now() / 1000) - 60 },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
)}`;

const requestResetToken = async (user) => {
  sendPasswordResetEmail.mockClear();
  await request(app).post('/api/auth/forgot-password').send({ email: user.email }).expect(200);
  const resetUrl = sendPasswordResetEmail.mock.calls[0][1];
  return new URL(resetUrl).searchParams.get('token');
};

describe('Password reset', () => {
  beforeEach(() => sendPasswordResetEmail.mockClear());

  describe('POST /api/auth/forgot-password', () => {
    test('emails a reset link for a known account', async () => {
      const user = await createTestUser({ email: email('known') });

      const res = await request(app).post('/api/auth/forgot-password').send({ email: user.email }).expect(200);

      expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
      const [sentTo, resetUrl] = sendPasswordResetEmail.mock.calls[0];
      expect(sentTo.email).toBe(user.email);
      expect(resetUrl).toMatch(/^https:\/\/app\.example\.com\/reset-password\?token=[0-9a-f]{64}$/);

      // Only the hash is stored, never the raw token.
      const saved = await User.findById(user._id).select('+password_reset_token_hash +password_reset_expires');
      const token = new URL(resetUrl).searchParams.get('token');
      expect(saved.password_reset_token_hash).toBe(User.hashResetToken(token));
      expect(saved.password_reset_token_hash).not.toBe(token);
      expect(saved.password_reset_expires.getTime()).toBeGreaterThan(Date.now());
      expect(res.body.message).toMatch(/If an account exists/);
    });

    test('gives the same response for an unknown email and sends nothing', async () => {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: email('nobody') }).expect(200);

      expect(res.body.message).toMatch(/If an account exists/);
      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    test('sends nothing for a deactivated account', async () => {
      const user = await createTestUser({ email: email('inactive'), is_active: false });

      await request(app).post('/api/auth/forgot-password').send({ email: user.email }).expect(200);

      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    test('rejects an invalid email', async () => {
      await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' }).expect(400);
    });
  });

  describe('POST /api/auth/reset-password', () => {
    test('sets the new password with a valid token, once', async () => {
      const user = await createTestUser({ email: email('reset'), password: 'OldPassword123' });
      const token = await requestResetToken(user);

      await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'NewPassword123' }).expect(200);

      await request(app).post('/api/auth/login').send({ email: user.email, password: 'OldPassword123' }).expect(400);
      await request(app).post('/api/auth/login').send({ email: user.email, password: 'NewPassword123' }).expect(200);

      // The token is single-use.
      const reuse = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Another123' }).expect(400);
      expect(reuse.body.error).toMatch(/invalid or has expired/);
    });

    test('rejects an expired token', async () => {
      const user = await createTestUser({ email: email('expired') });
      const token = await requestResetToken(user);
      await User.updateOne({ _id: user._id }, { password_reset_expires: new Date(Date.now() - 1000) });

      await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'NewPassword123' }).expect(400);
    });

    test('rejects an unknown token and a short password', async () => {
      await request(app).post('/api/auth/reset-password').send({ token: 'f'.repeat(64), newPassword: 'NewPassword123' }).expect(400);

      const user = await createTestUser({ email: email('short') });
      const token = await requestResetToken(user);
      await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'short' }).expect(400);
    });

    test('signs out sessions issued before the reset', async () => {
      const user = await createTestUser({ email: email('revoke') });
      const header = oldAuthHeader(user._id);
      await request(app).get('/api/auth/me').set('Authorization', header).expect(200);

      const token = await requestResetToken(user);
      await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'NewPassword123' }).expect(200);

      const res = await request(app).get('/api/auth/me').set('Authorization', header).expect(401);
      expect(res.body.error).toMatch(/Password was changed/);
      await request(app).get('/api/auth/me').set('Authorization', getAuthHeader(user._id)).expect(200);
    });
  });

  describe('POST /api/users/:id/reset-password (admin reset)', () => {
    test('admin sets a temporary password and flags it for change', async () => {
      const admin = await createTestUser({ role: 'admin', email: email('admin') });
      const staff = await createTestUser({ email: email('staff'), password: 'OldPassword123' });

      await request(app)
        .post(`/api/users/${staff._id}/reset-password`)
        .set('Authorization', getAuthHeader(admin._id))
        .send({ newPassword: 'TempPassword123' })
        .expect(200);

      const login = await request(app).post('/api/auth/login').send({ email: staff.email, password: 'TempPassword123' }).expect(200);
      expect(login.body.user.must_change_password).toBe(true);
    });

    test('rejects a short password and resetting your own', async () => {
      const admin = await createTestUser({ role: 'admin', email: email('admin') });
      const staff = await createTestUser({ email: email('staff') });

      await request(app)
        .post(`/api/users/${staff._id}/reset-password`)
        .set('Authorization', getAuthHeader(admin._id))
        .send({ newPassword: 'short' })
        .expect(400);
      await request(app)
        .post(`/api/users/${admin._id}/reset-password`)
        .set('Authorization', getAuthHeader(admin._id))
        .send({ newPassword: 'TempPassword123' })
        .expect(400);
    });

    test('a key worker can reset staff in their home but not an admin or another key worker', async () => {
      const home = await createTestHome();
      const keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
      const peer = await createTestUser({ role: 'key_worker', email: email('peer'), homes: [{ home_id: home._id }] });
      const admin = await createTestUser({ role: 'admin', email: email('admin') });
      const staff = await createTestUser({ email: email('staff'), homes: [{ home_id: home._id }] });
      const auth = getAuthHeader(keyWorker._id);

      await request(app).post(`/api/users/${staff._id}/reset-password`).set('Authorization', auth).send({ newPassword: 'TempPassword123' }).expect(200);
      await request(app).post(`/api/users/${admin._id}/reset-password`).set('Authorization', auth).send({ newPassword: 'TempPassword123' }).expect(403);
      await request(app).post(`/api/users/${peer._id}/reset-password`).set('Authorization', auth).send({ newPassword: 'TempPassword123' }).expect(403);
    });

    test('support workers cannot reset passwords', async () => {
      const worker = await createTestUser({ email: email('worker') });
      const staff = await createTestUser({ email: email('staff') });

      await request(app)
        .post(`/api/users/${staff._id}/reset-password`)
        .set('Authorization', getAuthHeader(worker._id))
        .send({ newPassword: 'TempPassword123' })
        .expect(403);
    });
  });

  describe('POST /api/auth/change-password', () => {
    test('clears the must-change flag and returns a token that still works', async () => {
      const user = await createTestUser({ email: email('change'), password: 'TempPassword123', must_change_password: true });
      const header = oldAuthHeader(user._id);

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', header)
        .send({ currentPassword: 'TempPassword123', newPassword: 'MyOwnPassword123' })
        .expect(200);

      expect(res.body.token).toBeTruthy();
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
      expect(me.body.user.must_change_password).toBe(false);
      await request(app).get('/api/auth/me').set('Authorization', header).expect(401);
    });
  });
});
