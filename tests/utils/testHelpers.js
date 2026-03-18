const User = require('../../models/User');
const Home = require('../../models/Home');
const Service = require('../../models/Service');
const Shift = require('../../models/Shift');
const jwt = require('jsonwebtoken');

// Note: These require statements are needed for the helper functions

/**
 * Create a test user
 */
exports.createTestUser = async (userData = {}) => {
  const defaultData = {
    name: 'Test User',
    email: `test${Date.now()}@example.com`,
    phone: '+1234567890',
    password: 'TestPassword123',
    role: 'support_worker',
    type: 'fulltime'
  };

  const user = new User({ ...defaultData, ...userData });
  await user.save();
  return user;
};

/**
 * Create a test home
 */
exports.createTestHome = async (homeData = {}) => {
  const defaultData = {
    name: 'Test Home',
    location: {
      address: '123 Test Street',
      city: 'Test City',
      postcode: 'TE1 5ST'
    },
    contact_info: {
      phone: '+1234567890',
      email: 'test@example.com'
    },
    capacity: 10,
    manager_id: null
  };

  const home = new Home({ ...defaultData, ...homeData });
  await home.save();
  return home;
};

/**
 * Create a test service
 */
exports.createTestService = async (serviceData = {}) => {
  const defaultData = {
    name: 'Test Service',
    description: 'Test Service Description',
    home_id: null,
    required_skills: [],
    min_staff_count: 1
  };

  const service = new Service({ ...defaultData, ...serviceData });
  await service.save();
  return service;
};

/**
 * Create a test shift
 */
exports.createTestShift = async (shiftData = {}) => {
  const defaultData = {
    home_id: null,
    service_id: null,
    date: new Date().toISOString().split('T')[0],
    start_time: '09:00',
    end_time: '17:00',
    shift_type: 'day',
    required_staff_count: 1,
    assigned_staff: []
  };

  const shift = new Shift({ ...defaultData, ...shiftData });
  await shift.save();
  return shift;
};

/**
 * Generate a JWT token for a user
 */
exports.generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || 'test-jwt-secret-key-for-testing-purposes-only',
    { expiresIn: '7d' }
  );
};

/**
 * Get authorization header for a user
 */
exports.getAuthHeader = (userId) => {
  const token = exports.generateToken(userId);
  return `Bearer ${token}`;
};

