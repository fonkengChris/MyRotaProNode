// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const moment = require('moment-timezone');
const app = require('../../../server');
const Shift = require('../../../models/Shift');
const ServiceUser = require('../../../models/ServiceUser');
const { APP_TIMEZONE } = require('../../../utils/shiftTime');
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
const at = (time, date = DATE) => moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', APP_TIMEZONE).toDate();

describe('1-to-1 shifts', () => {
  let admin, keyWorker, senior, worker, home, otherHome, service, serviceUser;

  beforeEach(async () => {
    home = await createTestHome({ name: 'Home A' });
    otherHome = await createTestHome({ name: 'Home B' });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    senior = await createTestUser({ role: 'senior_staff', email: email('ss'), homes: [{ home_id: home._id }] });
    worker = await createTestUser({ email: email('sw'), homes: [{ home_id: home._id }] });
    service = await createTestService({
      home_id: home._id,
      category: 'personal_care',
      duration_hours: 8,
      max_staff_count: 5,
    });
    serviceUser = await ServiceUser.create({ name: 'Alex', home_id: home._id });
  });

  const oneToOneBody = (overrides = {}) => ({
    home_id: home._id.toString(),
    service_id: service._id.toString(),
    service_user_id: serviceUser._id.toString(),
    date: DATE,
    start_time: '09:00',
    end_time: '11:00',
    shift_type: 'one_to_one',
    ...overrides,
  });

  const background = (overrides = {}) =>
    createTestShift({
      home_id: home._id,
      service_id: service._id,
      date: DATE,
      start_time: '08:00',
      end_time: '14:00',
      shift_type: 'day',
      ...overrides,
    });

  const oneToOne = (overrides = {}) =>
    createTestShift({
      home_id: home._id,
      service_id: service._id,
      service_user_id: serviceUser._id,
      date: DATE,
      start_time: '09:00',
      end_time: '11:00',
      shift_type: 'one_to_one',
      ...overrides,
    });

  const assign = (shift, user, as = admin) =>
    request(app)
      .post(`/api/shifts/${shift._id}/assign`)
      .set('Authorization', getAuthHeader(as._id))
      .send({ user_id: user._id.toString() });

  describe('create / edit', () => {
    test('admin creates a 1-to-1 for a service user (defaults to 1 staff)', async () => {
      const res = await request(app)
        .post('/api/shifts')
        .set('Authorization', getAuthHeader(admin._id))
        .send(oneToOneBody())
        .expect(201);
      expect(res.body.shift_type).toBe('one_to_one');
      expect(String(res.body.service_user_id)).toBe(serviceUser._id.toString());
      expect(res.body.required_staff_count).toBe(1);
    });

    test.each([['key_worker'], ['senior_staff']])('%s cannot create a 1-to-1', async (role) => {
      const user = role === 'key_worker' ? keyWorker : senior;
      await request(app)
        .post('/api/shifts')
        .set('Authorization', getAuthHeader(user._id))
        .send(oneToOneBody())
        .expect(403);
    });

    test('non-admins cannot edit or delete a 1-to-1', async () => {
      const shift = await oneToOne();
      await request(app)
        .put(`/api/shifts/${shift._id}`)
        .set('Authorization', getAuthHeader(keyWorker._id))
        .send({ notes: 'x' })
        .expect(403);
      await request(app)
        .delete(`/api/shifts/${shift._id}`)
        .set('Authorization', getAuthHeader(senior._id))
        .expect(403);
    });

    test('a service user is required', async () => {
      const res = await request(app)
        .post('/api/shifts')
        .set('Authorization', getAuthHeader(admin._id))
        .send(oneToOneBody({ service_user_id: '' }))
        .expect(400);
      expect(res.body.details.join(' ')).toMatch(/service user/i);
    });

    test("rejects a service user from another home", async () => {
      const elsewhere = await ServiceUser.create({ name: 'Sam', home_id: otherHome._id });
      await request(app)
        .post('/api/shifts')
        .set('Authorization', getAuthHeader(admin._id))
        .send(oneToOneBody({ service_user_id: elsewhere._id.toString() }))
        .expect(400);
    });

    test('a 1-to-1 may overlap a background shift at the same home', async () => {
      await background();
      await request(app)
        .post('/api/shifts')
        .set('Authorization', getAuthHeader(admin._id))
        .send(oneToOneBody())
        .expect(201);
    });

    test('background shifts at the same home may overlap; one staff member cannot work both', async () => {
      const create = (start_time, end_time) =>
        request(app)
          .post('/api/shifts')
          .set('Authorization', getAuthHeader(admin._id))
          .send(oneToOneBody({ shift_type: 'day', service_user_id: '', required_staff_count: 1, start_time, end_time }))
          .expect(201);
      const long = await create('08:00', '20:00');
      const short = await create('10:00', '18:00');

      const other = await createTestUser({ email: email('sw2'), homes: [{ home_id: home._id }] });
      await assign({ _id: long.body._id }, worker).expect(200);
      await assign({ _id: short.body._id }, other).expect(200);

      const third = await create('09:00', '17:00');
      const res = await assign({ _id: third.body._id }, worker).expect(409);
      expect(res.body.conflict.conflictType).toBe('overlapping_shift');
    });

    test('changing a 1-to-1 to a background type drops the service user', async () => {
      const shift = await oneToOne();
      const res = await request(app)
        .put(`/api/shifts/${shift._id}`)
        .set('Authorization', getAuthHeader(admin._id))
        .send({ shift_type: 'day', start_time: '18:00', end_time: '20:00' })
        .expect(200);
      expect(res.body.shift_type).toBe('day');
      expect(res.body.service_user_id).toBeNull();
    });

    test('1-to-1s are not offered for self-selection', async () => {
      await oneToOne();
      const res = await request(app)
        .get('/api/shifts/available')
        .set('Authorization', getAuthHeader(worker._id))
        .query({ user_id: worker._id.toString(), start_date: DATE, end_date: DATE })
        .expect(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('assignment', () => {
    test('only admins assign 1-to-1s', async () => {
      const shift = await oneToOne();
      await assign(shift, worker, keyWorker).expect(403);
      await assign(shift, worker, worker).expect(403);
    });

    test("a 1-to-1 over the staff member's own background shift is allowed and covered", async () => {
      const bg = await background();
      await assign(bg, worker).expect(200);
      const shift = await oneToOne();
      const res = await assign(shift, worker).expect(200);
      expect(res.body.covered_by_background).toBe(true);
    });

    test('two overlapping 1-to-1s for the same staff member are blocked', async () => {
      const first = await oneToOne();
      await assign(first, worker).expect(200);
      const other = await ServiceUser.create({ name: 'Sam', home_id: home._id });
      const second = await oneToOne({ service_user_id: other._id, start_time: '10:00', end_time: '12:00' });
      const res = await assign(second, worker).expect(409);
      expect(res.body.conflict.conflictType).toBe('overlapping_shift');
    });

    test('overlapping background shifts are still blocked', async () => {
      const first = await background();
      await assign(first, worker).expect(200);
      const second = await background({ start_time: '12:00', end_time: '18:00' });
      await assign(second, worker).expect(409);
    });

    test('a background shift crossing midnight blocks an early-morning background shift', async () => {
      const night = await background({ date: '2026-01-12', start_time: '22:00', end_time: '07:00', shift_type: 'night-wake' });
      await assign(night, worker).expect(200);
      const early = await background({ start_time: '06:00', end_time: '10:00' });
      await assign(early, worker).expect(409);
    });
  });

  describe('clock-in', () => {
    test('a covered 1-to-1 needs no clock-in', async () => {
      await background({ assigned_staff: [{ user_id: worker._id }] });
      const shift = await oneToOne({ assigned_staff: [{ user_id: worker._id }] });
      const res = await request(app)
        .post(`/api/shifts/${shift._id}/clock-in`)
        .set('Authorization', getAuthHeader(worker._id))
        .expect(409);
      expect(res.body.covered_by_background).toBe(true);
    });
  });

  describe('payroll', () => {
    const payroll = (mode) =>
      request(app)
        .get('/api/payroll')
        .set('Authorization', getAuthHeader(admin._id))
        .query({ start_date: DATE, end_date: DATE, home_id: home._id.toString(), mode })
        .expect(200);

    const rowFor = (res, user) => res.body.records.find((r) => r.user_id === user._id.toString());

    test('draft: a covered 1-to-1 adds no hours', async () => {
      await background({ assigned_staff: [{ user_id: worker._id }] });
      await oneToOne({ assigned_staff: [{ user_id: worker._id }] });
      const row = rowFor(await payroll('draft'), worker);
      expect(row.paid_hours).toBe(6);
      expect(row.one_to_one_hours).toBe(0);
    });

    test('draft: a 1-to-1 for an unrostered staff member counts in full', async () => {
      await oneToOne({ start_time: '10:00', end_time: '13:00', assigned_staff: [{ user_id: worker._id }] });
      const res = await payroll('draft');
      const row = rowFor(res, worker);
      expect(row.paid_hours).toBe(3);
      expect(row.one_to_one_hours).toBe(3);
      expect(res.body.totals.total_one_to_one_hours).toBe(3);
    });

    test('draft: a partial overlap only pays the extra time', async () => {
      await background({ assigned_staff: [{ user_id: worker._id }] });
      await oneToOne({ start_time: '12:00', end_time: '16:00', assigned_staff: [{ user_id: worker._id }] });
      const row = rowFor(await payroll('draft'), worker);
      expect(row.paid_hours).toBe(8);
      expect(row.one_to_one_hours).toBe(2);
    });

    test('final: covered 1-to-1 needs no clock-in; partial pays clocked extra time', async () => {
      await background({
        assigned_staff: [{ user_id: worker._id, clock_in_time: at('08:00'), clock_out_time: at('14:00') }],
      });
      // Covered, never clocked into → still adds nothing (and is not a problem).
      await oneToOne({ assigned_staff: [{ user_id: worker._id }] });
      const other = await ServiceUser.create({ name: 'Sam', home_id: home._id });
      await oneToOne({
        service_user_id: other._id,
        start_time: '12:00',
        end_time: '16:00',
        assigned_staff: [{ user_id: worker._id, clock_in_time: at('12:00'), clock_out_time: at('16:00') }],
      });
      const row = rowFor(await payroll('final'), worker);
      expect(row.paid_hours).toBe(8);
      expect(row.one_to_one_hours).toBe(2);
      expect(row.needs_review).toBe(0);
    });

    test('final: an uncovered 1-to-1 never clocked into is unpaid', async () => {
      await oneToOne({ start_time: '18:00', end_time: '20:00', assigned_staff: [{ user_id: worker._id }] });
      const row = rowFor(await payroll('final'), worker);
      expect(row).toBeUndefined();
    });
  });

  test('migrated 1-to-1s without a service user stay valid until edited', async () => {
    const legacy = await Shift.collection.insertOne({
      home_id: home._id,
      service_id: service._id,
      date: DATE,
      start_time: '09:00',
      end_time: '11:00',
      shift_type: 'one_to_one',
      service_user_id: null,
      required_staff_count: 1,
      assigned_staff: [],
      is_active: true,
    });
    const doc = await Shift.findById(legacy.insertedId);
    doc.assignStaff(worker._id);
    await expect(doc.save()).resolves.toBeTruthy();
  });
});
