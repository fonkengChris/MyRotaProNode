// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const TimeOffRequest = require('../../../models/TimeOffRequest');
const ServiceUser = require('../../../models/ServiceUser');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('Key workers only see leave for staff in homes where they have service users', () => {
  let admin, keyWorker, homeA, homeB, inA, inB, leaveA, leaveB;

  beforeEach(async () => {
    homeA = await createTestHome({ name: 'Home A' });
    homeB = await createTestHome({ name: 'Home B' });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    // Not attached to any home directly: reaches Home A only through a service user.
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [] });
    await ServiceUser.create({ name: 'Alex', home_id: homeA._id, key_worker_ids: [keyWorker._id] });

    inA = await createTestUser({ email: email('a'), homes: [{ home_id: homeA._id }] });
    inB = await createTestUser({ email: email('b'), homes: [{ home_id: homeB._id }] });
    const leave = (user) => TimeOffRequest.create({
      user_id: user._id, start_date: '2030-05-01', end_date: '2030-05-02', reason: 'Holiday', request_type: 'annual_leave'
    });
    leaveA = await leave(inA);
    leaveB = await leave(inB);
  });

  const get = (path, as) => request(app).get(`/api/timeoff${path}`).set('Authorization', getAuthHeader(as._id));
  const ids = (res) => res.body.map((r) => (r.user_id._id || r.user_id).toString());

  test('the list only includes staff in their service users\' homes', async () => {
    const res = await get('/', keyWorker).expect(200);
    expect(ids(res)).toEqual([inA._id.toString()]);

    await get(`/?user_id=${inB._id}`, keyWorker).expect(403);
    const filtered = await get(`/?home_id=${homeB._id}`, keyWorker).expect(200);
    expect(filtered.body).toHaveLength(0);
  });

  test('single requests and per-user lists outside their homes are refused', async () => {
    await get(`/${leaveA._id}`, keyWorker).expect(200);
    await get(`/${leaveB._id}`, keyWorker).expect(403);
    await get(`/user/${inA._id}`, keyWorker).expect(200);
    await get(`/user/${inB._id}`, keyWorker).expect(403);
  });

  test('they cannot create, edit or delete leave for staff outside their homes', async () => {
    const auth = getAuthHeader(keyWorker._id);
    await request(app).post('/api/timeoff').set('Authorization', auth)
      .send({ user_id: inB._id.toString(), start_date: '2030-06-01', end_date: '2030-06-01', reason: 'x' })
      .expect(403);
    await request(app).put(`/api/timeoff/${leaveB._id}`).set('Authorization', auth).send({ reason: 'x' }).expect(403);
    await request(app).delete(`/api/timeoff/${leaveB._id}`).set('Authorization', auth).expect(403);
    await request(app).delete(`/api/timeoff/${leaveA._id}`).set('Authorization', auth).expect(200);
  });

  test('losing the service user removes access', async () => {
    await ServiceUser.updateMany({ key_worker_ids: keyWorker._id }, { is_active: false });
    const res = await get('/', keyWorker).expect(200);
    expect(res.body).toHaveLength(0);
  });

  test('senior staff only see and manage their own leave', async () => {
    const senior = await createTestUser({ role: 'senior_staff', email: email('ss'), homes: [{ home_id: homeA._id }] });
    const res = await get('/', senior).expect(200);
    expect(res.body).toHaveLength(0);
    await get(`/${leaveA._id}`, senior).expect(403);
    await get(`/?user_id=${inA._id}`, senior).expect(403);
    await get(`/user/${inA._id}`, senior).expect(403);

    const auth = getAuthHeader(senior._id);
    await request(app).post('/api/timeoff').set('Authorization', auth)
      .send({ user_id: inA._id.toString(), start_date: '2030-06-01', end_date: '2030-06-01', reason: 'x' })
      .expect(403);
    await request(app).put(`/api/timeoff/${leaveA._id}`).set('Authorization', auth).send({ reason: 'x' }).expect(403);
    await request(app).delete(`/api/timeoff/${leaveA._id}`).set('Authorization', auth).expect(403);

    const ownCreated = await request(app).post('/api/timeoff').set('Authorization', auth)
      .send({ user_id: senior._id.toString(), start_date: '2030-06-01', end_date: '2030-06-01', reason: 'Holiday', request_type: 'annual_leave' })
      .expect(201);
    const own = await get('/', senior).expect(200);
    expect(own.body.map((r) => r._id)).toEqual([ownCreated.body._id]);
  });

  test('regular staff only see their own leave; admins see everyone', async () => {
    const own = await get('/', inA).expect(200);
    expect(ids(own)).toEqual([inA._id.toString()]);
    await get(`/${leaveB._id}`, inA).expect(403);

    const all = await get('/', admin).expect(200);
    expect(ids(all).sort()).toEqual([inA._id.toString(), inB._id.toString()].sort());
  });
});
