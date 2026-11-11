// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const Availability = require('../../../models/Availability');
const KeyWorkerAccessSettings = require('../../../models/KeyWorkerAccessSettings');
const TimeOffRequest = require('../../../models/TimeOffRequest');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('Availability permissions (part-time/bank self-declare, admin manages everyone)', () => {
  let admin, keyWorker, fulltime, parttime, bank;

  beforeEach(async () => {
    const home = await createTestHome();
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    fulltime = await createTestUser({ type: 'fulltime', email: email('ft'), homes: [{ home_id: home._id }] });
    parttime = await createTestUser({ type: 'parttime', email: email('pt'), homes: [{ home_id: home._id }] });
    bank = await createTestUser({ type: 'bank', email: email('bank'), homes: [{ home_id: home._id }] });
  });

  const body = (user, date = '2030-01-07') => ({
    user_id: user._id.toString(), date, start_time: '09:00', end_time: '17:00', is_available: true, preferred_shift_type: 'day'
  });

  const declare = (as, forUser) =>
    request(app).post('/api/availability').set('Authorization', getAuthHeader(as._id)).send(body(forUser));

  const existingFor = (user) => Availability.create(body(user));

  it('stops full-time staff declaring their own availability', async () => {
    const res = await declare(fulltime, fulltime);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AVAILABILITY_FORBIDDEN');
    expect(res.body.error).toMatch(/managed by an admin/);
  });

  it('lets part-time and bank staff declare their own availability', async () => {
    expect((await declare(parttime, parttime)).status).toBe(201);
    expect((await declare(bank, bank)).status).toBe(201);
  });

  it('stops staff declaring availability for someone else', async () => {
    expect((await declare(parttime, bank)).status).toBe(403);
  });

  it('lets key workers with full staff access declare availability for staff', async () => {
    expect((await declare(keyWorker, parttime)).status).toBe(201);
  });

  it('stops key workers without full staff access declaring availability for staff', async () => {
    await KeyWorkerAccessSettings.create({ staff: 'view' });
    expect((await declare(keyWorker, parttime)).status).toBe(403);
  });

  it('stops full-time key workers declaring their own availability', async () => {
    expect((await declare(keyWorker, keyWorker)).status).toBe(403);
  });

  it('stops key workers declaring availability for admins', async () => {
    expect((await declare(keyWorker, admin)).status).toBe(403);
  });

  it('lets an admin declare, update and delete availability for any staff member', async () => {
    const created = await declare(admin, fulltime);
    expect(created.status).toBe(201);

    const id = created.body._id;
    const updated = await request(app)
      .put(`/api/availability/${id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ status: 'unavailable' });
    expect(updated.status).toBe(200);
    expect(updated.body.is_available).toBe(false);

    const deleted = await request(app)
      .delete(`/api/availability/${id}`)
      .set('Authorization', getAuthHeader(admin._id));
    expect(deleted.status).toBe(200);
    expect(await Availability.findById(id)).toBeNull();
  });

  it('lets part-time staff update and delete their own records', async () => {
    const record = await existingFor(parttime);

    const updated = await request(app)
      .put(`/api/availability/${record._id}`)
      .set('Authorization', getAuthHeader(parttime._id))
      .send({ status: 'unavailable' });
    expect(updated.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/availability/${record._id}`)
      .set('Authorization', getAuthHeader(parttime._id));
    expect(deleted.status).toBe(200);
  });

  it('stops full-time staff changing availability an admin set for them', async () => {
    const record = await existingFor(fulltime);

    const updated = await request(app)
      .put(`/api/availability/${record._id}`)
      .set('Authorization', getAuthHeader(fulltime._id))
      .send({ status: 'unavailable' });
    expect(updated.status).toBe(403);

    const deleted = await request(app)
      .delete(`/api/availability/${record._id}`)
      .set('Authorization', getAuthHeader(fulltime._id));
    expect(deleted.status).toBe(403);
    expect(await Availability.findById(record._id)).not.toBeNull();
  });

  it('does not let an update reassign a record to another staff member', async () => {
    const record = await existingFor(parttime);

    const res = await request(app)
      .put(`/api/availability/${record._id}`)
      .set('Authorization', getAuthHeader(parttime._id))
      .send({ user_id: bank._id.toString(), status: 'unavailable' });
    expect(res.status).toBe(200);
    expect(String(res.body.user_id)).toBe(parttime._id.toString());
  });
});

describe('Availability read scope', () => {
  let admin, keyWorker, parttime, bank, otherHomeStaff;

  beforeEach(async () => {
    const home = await createTestHome();
    const otherHome = await createTestHome();
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    parttime = await createTestUser({ type: 'parttime', email: email('pt'), homes: [{ home_id: home._id }] });
    bank = await createTestUser({ type: 'bank', email: email('bank'), homes: [{ home_id: home._id }] });
    otherHomeStaff = await createTestUser({ type: 'parttime', email: email('oh'), homes: [{ home_id: otherHome._id }] });
    for (const u of [admin, parttime, bank, otherHomeStaff]) {
      await Availability.create({ user_id: u._id, date: '2030-03-04', start_time: '09:00', end_time: '17:00', is_available: true });
    }
  });

  const get = (as, path, query = {}) =>
    request(app).get(`/api/availability${path}`).query(query).set('Authorization', getAuthHeader(as._id));
  const owners = (res) => res.body.map((a) => String(a.user_id._id || a.user_id)).sort();

  it('shows staff only their own records when listing without a user filter', async () => {
    const res = await get(parttime, '');
    expect(res.status).toBe(200);
    expect(owners(res)).toEqual([parttime._id.toString()]);
  });

  it("stops staff reading someone else's availability", async () => {
    expect((await get(parttime, '', { user_id: bank._id.toString() })).status).toBe(403);
    expect((await get(parttime, `/user/${bank._id}`)).status).toBe(403);
    const record = await Availability.findOne({ user_id: bank._id });
    expect((await get(parttime, `/${record._id}`)).status).toBe(404);
  });

  it('lets an admin list everyone', async () => {
    const res = await get(admin, '');
    expect(res.body).toHaveLength(4);
  });

  it('lets a key worker with all-home scope see every non-admin', async () => {
    const res = await get(keyWorker, '');
    expect(owners(res)).toEqual([parttime, bank, otherHomeStaff].map((u) => u._id.toString()).sort());
  });

  it("limits a key worker with own-home scope to their homes' staff", async () => {
    await KeyWorkerAccessSettings.create({ home_scope: 'own' });
    const res = await get(keyWorker, '');
    expect(owners(res)).toEqual([parttime, bank].map((u) => u._id.toString()).sort());
    expect((await get(keyWorker, `/user/${otherHomeStaff._id}`)).status).toBe(403);
  });

  it('lets a key worker with view-only staff access read staff availability', async () => {
    await KeyWorkerAccessSettings.create({ staff: 'view' });
    expect((await get(keyWorker, '', { user_id: parttime._id.toString() })).status).toBe(200);
  });

  it('hides staff availability from key workers whose staff access is hidden', async () => {
    await KeyWorkerAccessSettings.create({ staff: 'hidden' });
    expect((await get(keyWorker, '', { user_id: parttime._id.toString() })).status).toBe(403);
    expect((await get(keyWorker, '')).body).toHaveLength(0);
  });
});

describe('Availability on approved leave', () => {
  let admin, parttime;
  const auth = (u) => getAuthHeader(u._id);

  beforeEach(async () => {
    const home = await createTestHome();
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    parttime = await createTestUser({ type: 'parttime', email: email('pt'), homes: [{ home_id: home._id }] });
  });

  const leave = (status, start_date = '2030-04-01', end_date = '2030-04-03') => TimeOffRequest.create({
    user_id: parttime._id, start_date, end_date, reason: 'Holiday', request_type: 'annual_leave', status
  });
  const approve = (req) => request(app).post(`/api/timeoff/${req._id}/approve`).set('Authorization', auth(admin)).send({});
  const cancel = (req) => request(app).delete(`/api/timeoff/${req._id}`).set('Authorization', auth(admin));
  const own = (date, extra = {}) => ({
    user_id: parttime._id.toString(), date, status: 'partial', start_time: '10:00', end_time: '14:00', preferred_shift_type: 'day', notes: 'Mornings only', ...extra
  });

  it('refuses to create, update or delete availability on a day of approved leave, even for admins', async () => {
    const req = await leave('pending');
    expect((await approve(req)).status).toBe(200);
    const marker = await Availability.findOne({ user_id: parttime._id, date: '2030-04-02' });

    const post = await request(app).post('/api/availability').set('Authorization', auth(parttime)).send(own('2030-04-02'));
    expect(post.status).toBe(409);
    expect(post.body.code).toBe('AVAILABILITY_ON_LEAVE');

    for (const as of [parttime, admin]) {
      expect((await request(app).put(`/api/availability/${marker._id}`).set('Authorization', auth(as)).send({ status: 'available' })).status).toBe(409);
      expect((await request(app).delete(`/api/availability/${marker._id}`).set('Authorization', auth(as))).status).toBe(409);
    }
    const after = await Availability.findById(marker._id);
    expect(after.is_available).toBe(false);
  });

  it('refuses to move a record onto a day of approved leave', async () => {
    await leave('approved');
    const record = await Availability.create(own('2030-04-10'));
    const res = await request(app).put(`/api/availability/${record._id}`).set('Authorization', auth(parttime)).send({ date: '2030-04-02' });
    expect(res.status).toBe(409);
  });

  it('ignores pre_leave sent by a client', async () => {
    const res = await request(app).post('/api/availability').set('Authorization', auth(parttime))
      .send({ ...own('2030-04-20'), pre_leave: { is_available: true, notes: 'sneaky' } });
    expect(res.status).toBe(201);
    expect((await Availability.findById(res.body._id)).pre_leave).toBeUndefined();
  });

  it("puts the person's own entry back when approved leave is cancelled", async () => {
    await Availability.create(own('2030-04-01'));
    const req = await leave('pending');
    await approve(req);

    const during = await Availability.findOne({ user_id: parttime._id, date: '2030-04-01' });
    expect(during.is_available).toBe(false);
    expect(during.notes).toMatch(/^Approved leave: /);

    expect((await cancel(req)).status).toBe(200);
    const restored = await Availability.findOne({ user_id: parttime._id, date: '2030-04-01' });
    expect(restored).toMatchObject({ status: 'partial', start_time: '10:00', end_time: '14:00', is_available: true, preferred_shift_type: 'day', notes: 'Mornings only' });
    expect(restored.pre_leave).toBeUndefined();
    // Days with nothing before the leave are simply freed.
    expect(await Availability.findOne({ user_id: parttime._id, date: '2030-04-02' })).toBeNull();
  });

  it('keeps the original entry through overlapping leave and restores it when the last is cancelled', async () => {
    await Availability.create(own('2030-04-02'));
    const first = await leave('pending', '2030-04-01', '2030-04-03');
    await approve(first);
    const second = await leave('pending', '2030-04-02', '2030-04-02');
    await approve(second);

    await cancel(first);
    const stillLeave = await Availability.findOne({ user_id: parttime._id, date: '2030-04-02' });
    expect(stillLeave.is_available).toBe(false);

    await cancel(second);
    const restored = await Availability.findOne({ user_id: parttime._id, date: '2030-04-02' });
    expect(restored).toMatchObject({ is_available: true, notes: 'Mornings only' });
  });
});

describe('Availability "No preference"', () => {
  it('saves a blank or null preferred shift type as none, and clears a preference on update', async () => {
    const parttime = await createTestUser({ type: 'parttime', email: email('np') });
    const post = (preferred_shift_type, date) =>
      request(app)
        .post('/api/availability')
        .set('Authorization', getAuthHeader(parttime._id))
        .send({ user_id: parttime._id.toString(), date, start_time: '09:00', end_time: '17:00', is_available: true, preferred_shift_type });

    const blank = await post('', '2030-02-01');
    expect(blank.status).toBe(201);
    expect(blank.body.preferred_shift_type).toBe('none');

    const nul = await post(null, '2030-02-02');
    expect(nul.status).toBe(201);
    expect(nul.body.preferred_shift_type).toBe('none');

    const withPref = await post('day', '2030-02-03');
    const cleared = await request(app)
      .put(`/api/availability/${withPref.body._id}`)
      .set('Authorization', getAuthHeader(parttime._id))
      .send({ preferred_shift_type: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.preferred_shift_type).toBe('none');
  });
});
