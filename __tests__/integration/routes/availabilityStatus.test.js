// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const Availability = require('../../../models/Availability');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('Availability status (available / unavailable / partial)', () => {
  let parttime;

  beforeEach(async () => {
    parttime = await createTestUser({ type: 'parttime', email: email('pt') });
  });

  const post = (body, date = '2030-05-06') =>
    request(app)
      .post('/api/availability')
      .set('Authorization', getAuthHeader(parttime._id))
      .send({ user_id: parttime._id.toString(), date, ...body });

  it('keeps the time slot only for partial days', async () => {
    const partial = await post({ status: 'partial', start_time: '09:00', end_time: '13:00' });
    expect(partial.status).toBe(201);
    expect(partial.body).toMatchObject({ status: 'partial', start_time: '09:00', end_time: '13:00', is_available: true });

    const available = await post({ status: 'available', start_time: '09:00', end_time: '13:00' }, '2030-05-07');
    expect(available.body.status).toBe('available');
    expect(available.body.start_time).toBeUndefined();

    const unavailable = await post({ status: 'unavailable' }, '2030-05-08');
    expect(unavailable.body).toMatchObject({ status: 'unavailable', is_available: false });
  });

  it('requires a start and end time for partial days', async () => {
    expect((await post({ status: 'partial' })).status).toBe(400);
    expect((await post({ status: 'partial', start_time: '09:00', end_time: '09:00' })).status).toBe(400);
  });

  it('rejects an unknown status', async () => {
    expect((await post({ status: 'maybe' })).status).toBe(400);
  });

  it('accepts the older is_available flag', async () => {
    const res = await post({ is_available: false, start_time: '00:00', end_time: '23:59' });
    expect(res.body).toMatchObject({ status: 'unavailable', is_available: false });
  });

  it('drops the time slot when a partial day becomes available', async () => {
    const created = await post({ status: 'partial', start_time: '09:00', end_time: '13:00' });
    const res = await request(app)
      .put(`/api/availability/${created.body._id}`)
      .set('Authorization', getAuthHeader(parttime._id))
      .send({ status: 'available' });
    expect(res.status).toBe(200);
    const saved = await Availability.findById(created.body._id);
    expect(saved.status).toBe('available');
    expect(saved.start_time).toBeUndefined();
  });
});

describe('Manual assignment respects availability', () => {
  let admin, keyWorker, worker, home, service;
  const DATE = '2030-05-13';

  beforeEach(async () => {
    home = await createTestHome();
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 12, max_staff_count: 5 });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    worker = await createTestUser({ type: 'parttime', email: email('sw'), homes: [{ home_id: home._id }] });
  });

  const shiftAt = (start_time, end_time, date = DATE) =>
    createTestShift({ home_id: home._id, service_id: service._id, date, start_time, end_time });
  const declare = (date, body) => Availability.create({ user_id: worker._id, date, ...body });
  const assign = (shift, as, extra = {}) =>
    request(app)
      .post(`/api/shifts/${shift._id}/assign`)
      .set('Authorization', getAuthHeader(as._id))
      .send({ user_id: worker._id.toString(), ...extra });

  it('blocks a key worker from assigning someone on a day they marked unavailable', async () => {
    await declare(DATE, { status: 'unavailable' });
    const res = await assign(await shiftAt('09:00', '17:00'), keyWorker);
    expect(res.status).toBe(409);
    expect(res.body.overridableConflicts.map((c) => c.conflictType)).toContain('unavailable');
    expect(res.body.overridable).toBe(false);
  });

  it('allows a shift inside a partial day and blocks one outside it', async () => {
    await declare(DATE, { status: 'partial', start_time: '08:00', end_time: '14:00' });
    expect((await assign(await shiftAt('08:00', '14:00'), keyWorker)).status).toBe(200);

    const res = await assign(await shiftAt('15:00', '20:00'), keyWorker);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/only available 08:00–14:00/);
  });

  it("blocks a night shift that runs into the next day's unavailability", async () => {
    await declare('2030-05-14', { status: 'unavailable' });
    const res = await assign(await shiftAt('22:00', '08:00'), keyWorker);
    expect(res.status).toBe(409);
    expect(res.body.overridableConflicts.map((c) => c.conflictType)).toContain('unavailable');
  });

  it('lets an admin assign outside availability after confirming', async () => {
    await declare(DATE, { status: 'unavailable' });
    const shift = await shiftAt('09:00', '17:00');
    const prompt = await assign(shift, admin);
    expect(prompt.status).toBe(409);
    expect(prompt.body.overridable).toBe(true);
    expect((await assign(shift, admin, { override: true })).status).toBe(200);
  });

  it('does not let staff select a shift outside their own partial hours', async () => {
    await declare(DATE, { status: 'partial', start_time: '08:00', end_time: '12:00' });
    const shift = await shiftAt('13:00', '17:00');
    const preview = await request(app)
      .post('/api/shifts/assign-preview')
      .set('Authorization', getAuthHeader(worker._id))
      .send({ shift_ids: [shift._id.toString()] });
    expect(preview.body[shift._id].outcome).toBe('blocked');
  });
});
