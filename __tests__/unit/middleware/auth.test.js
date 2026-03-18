const jwt = require('jsonwebtoken');
const { authenticateToken, requireRole, requireHomeAccess } = require('../../../middleware/auth');
const User = require('../../../models/User');
const { createTestUser, createTestHome } = require('../../../tests/utils/testHelpers');

// Mock Express request/response/next
const createMockReq = (headers = {}, user = null) => ({
  headers,
  user,
  params: {},
  body: {}
});

const createMockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createMockNext = () => jest.fn();

describe('Auth Middleware', () => {
  describe('authenticateToken', () => {
    test('should authenticate valid token and set user', async () => {
      const user = await createTestUser();
      const token = jwt.sign(
        { userId: user._id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      const req = createMockReq({ authorization: `Bearer ${token}` });
      const res = createMockRes();
      const next = createMockNext();

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user._id.toString()).toBe(user._id.toString());
    });

    test('should fail without token', async () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      await authenticateToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('No token provided')
        })
      );
    });

    test('should fail with invalid token', async () => {
      const req = createMockReq({ authorization: 'Bearer invalid-token' });
      const res = createMockRes();
      const next = createMockNext();

      await authenticateToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Invalid token')
        })
      );
    });

    test('should fail with expired token', async () => {
      const user = await createTestUser();
      const token = jwt.sign(
        { userId: user._id },
        process.env.JWT_SECRET,
        { expiresIn: '-1h' }
      );

      const req = createMockReq({ authorization: `Bearer ${token}` });
      const res = createMockRes();
      const next = createMockNext();

      await authenticateToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('expired')
        })
      );
    });

    test('should fail if user not found', async () => {
      const mongoose = require('mongoose');
      const fakeId = new mongoose.Types.ObjectId();
      const token = jwt.sign(
        { userId: fakeId },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      const req = createMockReq({ authorization: `Bearer ${token}` });
      const res = createMockRes();
      const next = createMockNext();

      await authenticateToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('should fail if user is deactivated', async () => {
      const user = await createTestUser({ is_active: false });
      const token = jwt.sign(
        { userId: user._id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      const req = createMockReq({ authorization: `Bearer ${token}` });
      const res = createMockRes();
      const next = createMockNext();

      await authenticateToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('requireRole', () => {
    test('should allow access for correct role', () => {
      const user = { role: 'admin' };
      const req = createMockReq({}, user);
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireRole('admin');
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should allow access for one of multiple roles', () => {
      const user = { role: 'home_manager' };
      const req = createMockReq({}, user);
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireRole(['admin', 'home_manager']);
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should deny access for incorrect role', () => {
      const user = { role: 'support_worker' };
      const req = createMockReq({}, user);
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireRole('admin');
      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('should deny access without user', () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireRole('admin');
      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('requireHomeAccess', () => {
    test('should allow admin to access any home', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const home = await createTestHome();

      const req = createMockReq({}, admin);
      req.params.homeId = home._id.toString();
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireHomeAccess('homeId');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should allow user to access their own home', async () => {
      const user = await createTestUser();
      const home = await createTestHome();

      user.addHome(home._id, true);
      await user.save();

      const req = createMockReq({}, user);
      req.params.homeId = home._id.toString();
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireHomeAccess('homeId');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should deny access to home not assigned to user', async () => {
      const user = await createTestUser();
      const home = await createTestHome();

      const req = createMockReq({}, user);
      req.params.homeId = home._id.toString();
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireHomeAccess('homeId');
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('should use home_id from body if param not found', async () => {
      const user = await createTestUser();
      const home = await createTestHome();

      user.addHome(home._id, true);
      await user.save();

      const req = createMockReq({}, user);
      req.body.home_id = home._id.toString();
      const res = createMockRes();
      const next = createMockNext();

      const middleware = requireHomeAccess('homeId');
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

