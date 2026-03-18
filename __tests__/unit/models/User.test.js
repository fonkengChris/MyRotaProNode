const User = require('../../../models/User');
const { createTestUser, createTestHome } = require('../../../tests/utils/testHelpers');

describe('User Model', () => {
  describe('Schema Validation', () => {
    test('should create a user with valid data', async () => {
      const userData = {
        name: 'John Doe',
        email: 'john@example.com',
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker',
        type: 'fulltime'
      };

      const user = new User(userData);
      const savedUser = await user.save();

      expect(savedUser._id).toBeDefined();
      expect(savedUser.name).toBe(userData.name);
      expect(savedUser.email).toBe(userData.email.toLowerCase());
      expect(savedUser.role).toBe(userData.role);
      expect(savedUser.is_active).toBe(true);
    });

    test('should fail without required fields', async () => {
      const user = new User({});
      await expect(user.save()).rejects.toThrow();
    });

    test('should fail with invalid email format', async () => {
      const user = new User({
        name: 'John Doe',
        email: 'invalid-email',
        phone: '+1234567890',
        password: 'Password123',
        role: 'support_worker'
      });

      await expect(user.save()).rejects.toThrow();
    });

    test('should fail with invalid phone format', async () => {
      const user = new User({
        name: 'John Doe',
        email: 'john@example.com',
        phone: 'invalid-phone',
        password: 'Password123',
        role: 'support_worker'
      });

      await expect(user.save()).rejects.toThrow();
    });

    test('should fail with invalid role', async () => {
      const user = new User({
        name: 'John Doe',
        email: 'john@example.com',
        phone: '+1234567890',
        password: 'Password123',
        role: 'invalid_role'
      });

      await expect(user.save()).rejects.toThrow();
    });

    test('should fail with password less than 8 characters', async () => {
      const user = new User({
        name: 'John Doe',
        email: 'john@example.com',
        phone: '+1234567890',
        password: 'short',
        role: 'support_worker'
      });

      await expect(user.save()).rejects.toThrow();
    });
  });

  describe('Password Hashing', () => {
    test('should hash password before saving', async () => {
      const password = 'TestPassword123';
      const user = await createTestUser({ password });

      expect(user.password).not.toBe(password);
      expect(user.password).toHaveLength(60); // bcrypt hash length
    });

    test('should not hash password if not modified', async () => {
      const user = await createTestUser();
      const originalPassword = user.password;

      user.name = 'Updated Name';
      await user.save();

      expect(user.password).toBe(originalPassword);
    });
  });

  describe('comparePassword Method', () => {
    test('should return true for correct password', async () => {
      const password = 'TestPassword123';
      const user = await createTestUser({ password });

      const isValid = await user.comparePassword(password);
      expect(isValid).toBe(true);
    });

    test('should return false for incorrect password', async () => {
      const user = await createTestUser({ password: 'TestPassword123' });

      const isValid = await user.comparePassword('WrongPassword');
      expect(isValid).toBe(false);
    });
  });

  describe('getPermissions Method', () => {
    test('should return correct permissions for admin', async () => {
      const user = await createTestUser({ role: 'admin' });
      const permissions = user.getPermissions();

      expect(permissions.can_manage_users).toBe(true);
      expect(permissions.can_manage_rotas).toBe(true);
      expect(permissions.can_view_all_homes).toBe(true);
      expect(permissions.can_manage_homes).toBe(true);
    });

    test('should return correct permissions for support_worker', async () => {
      const user = await createTestUser({ role: 'support_worker' });
      const permissions = user.getPermissions();

      expect(permissions.can_manage_users).toBe(false);
      expect(permissions.can_manage_rotas).toBe(false);
      expect(permissions.can_view_all_homes).toBe(false);
    });

    test('should return correct permissions for home_manager', async () => {
      const user = await createTestUser({ role: 'home_manager' });
      const permissions = user.getPermissions();

      expect(permissions.can_manage_users).toBe(true);
      expect(permissions.can_manage_rotas).toBe(true);
      expect(permissions.can_view_all_homes).toBe(false);
    });
  });

  describe('addHome Method', () => {
    test('should add a home to user', async () => {
      const user = await createTestUser();
      const home = await createTestHome();

      user.addHome(home._id, true);
      await user.save();

      expect(user.homes).toHaveLength(1);
      expect(user.homes[0].home_id.toString()).toBe(home._id.toString());
      expect(user.homes[0].is_default).toBe(true);
      expect(user.default_home_id.toString()).toBe(home._id.toString());
    });

    test('should update existing home if already added', async () => {
      const user = await createTestUser();
      const home = await createTestHome();

      user.addHome(home._id, false);
      await user.save();

      user.addHome(home._id, true);
      await user.save();

      expect(user.homes).toHaveLength(1);
      expect(user.homes[0].is_default).toBe(true);
    });

    test('should remove default flag from other homes when setting new default', async () => {
      const user = await createTestUser();
      const home1 = await createTestHome();
      const home2 = await createTestHome();

      user.addHome(home1._id, true);
      await user.save();

      user.addHome(home2._id, true);
      await user.save();

      expect(user.homes).toHaveLength(2);
      expect(user.homes.find(h => h.home_id.toString() === home1._id.toString()).is_default).toBe(false);
      expect(user.homes.find(h => h.home_id.toString() === home2._id.toString()).is_default).toBe(true);
    });
  });

  describe('removeHome Method', () => {
    test('should remove a home from user', async () => {
      const user = await createTestUser();
      const home = await createTestHome();

      user.addHome(home._id, true);
      await user.save();

      const removed = user.removeHome(home._id);
      await user.save();

      expect(removed).toBe(true);
      expect(user.homes).toHaveLength(0);
      expect(user.default_home_id).toBeNull();
    });

    test('should set new default home if default was removed', async () => {
      const user = await createTestUser();
      const home1 = await createTestHome();
      const home2 = await createTestHome();

      user.addHome(home1._id, true);
      user.addHome(home2._id, false);
      await user.save();

      user.removeHome(home1._id);
      await user.save();

      expect(user.homes).toHaveLength(1);
      expect(user.homes[0].is_default).toBe(true);
      expect(user.default_home_id.toString()).toBe(home2._id.toString());
    });

    test('should return false if home not found', async () => {
      const user = await createTestUser();
      const home = await createTestHome();

      const removed = user.removeHome(home._id);
      expect(removed).toBe(false);
    });
  });

  describe('findByRoleAndHome Static Method', () => {
    test('should find all admins regardless of home', async () => {
      const admin1 = await createTestUser({ role: 'admin' });
      const admin2 = await createTestUser({ role: 'admin' });
      const worker = await createTestUser({ role: 'support_worker' });

      const admins = await User.findByRoleAndHome('admin', null);
      expect(admins.length).toBeGreaterThanOrEqual(2);
      expect(admins.some(a => a._id.toString() === admin1._id.toString())).toBe(true);
      expect(admins.some(a => a._id.toString() === admin2._id.toString())).toBe(true);
    });

    test('should find users by role and home', async () => {
      const home = await createTestHome();
      const user1 = await createTestUser({ role: 'support_worker' });
      const user2 = await createTestUser({ role: 'support_worker' });

      user1.addHome(home._id, true);
      await user1.save();

      const users = await User.findByRoleAndHome('support_worker', home._id);
      expect(users.length).toBeGreaterThanOrEqual(1);
      expect(users.some(u => u._id.toString() === user1._id.toString())).toBe(true);
    });
  });

  describe('Virtual Properties', () => {
    test('should exclude password from publicInfo', async () => {
      const user = await createTestUser();
      const publicInfo = user.publicInfo;

      expect(publicInfo.password).toBeUndefined();
      expect(publicInfo.id).toBeDefined();
      expect(publicInfo.name).toBe(user.name);
      expect(publicInfo.email).toBe(user.email);
    });

    test('should exclude password from JSON output', async () => {
      const user = await createTestUser();
      const json = user.toJSON();

      expect(json.password).toBeUndefined();
      expect(json.name).toBeDefined();
    });
  });

  describe('Default Hours Based on Type', () => {
    test('should set default hours for fulltime', async () => {
      const user = await createTestUser({ type: 'fulltime' });
      expect(user.min_hours_per_week).toBe(40);
    });

    test('should set default hours for parttime', async () => {
      const user = await createTestUser({ type: 'parttime' });
      expect(user.min_hours_per_week).toBe(20);
    });

    test('should set default hours for bank', async () => {
      const user = await createTestUser({ type: 'bank' });
      expect(user.min_hours_per_week).toBe(0);
    });
  });
});

