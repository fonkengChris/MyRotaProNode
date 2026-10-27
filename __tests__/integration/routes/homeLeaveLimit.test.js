// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const TimeOffRequest = require('../../../models/TimeOffRequest');
const SolverSettings = require('../../../models/SolverSettings');
const Availability = require('../../../models/Availability');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('Home leave limit (default 3 staff on leave at once, admin override above it)', () => {
  let admin, keyWorker, home, otherHome, staff;

  beforeEach(async () => {
    home = await createTestHome();
    otherHome = await createTestHome({ name: 'Other Home' });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    staff = [];
    for (let i = 0; i < 5; i++) {
      staff.push(await createTestUser({ email: email(`sw${i}`), homes: [{ home_id: home._id }] }));
    }
  });

  const approvedLeave = (user, start_date, end_date) => TimeOffRequest.create({
    user_id: user._id, start_date, end_date, reason: 'Holiday', request_type: 'annual_leave', status: 'approved'
  });

  const submit = (user, start_date, end_date, request_type = 'annual_leave') =>
    request(app)
      .post('/api/timeoff')
      .set('Authorization', getAuthHeader(user._id))
      .send({ user_id: user._id.toString(), start_date, end_date, reason: 'Holiday', request_type });

  const approve = (id, as, override) =>
    request(app)
      .post(`/api/timeoff/${id}/approve`)
      .set('Authorization', getAuthHeader(as._id))
      .send(override ? { override_home_leave_limit: true } : {});

  test('a third person on leave at once is within the limit', async () => {
    await approvedLeave(staff[0], '2030-06-01', '2030-06-07');
    await approvedLeave(staff[1], '2030-06-03', '2030-06-10');

    const res = await submit(staff[2], '2030-06-05', '2030-06-06');
    expect(res.status).toBe(201);
    expect(res.body.home_leave_limit_warning).toBeUndefined();
    await approve(res.body._id, admin).expect(200);
  });

  test('a fourth person is flagged and needs an explicit admin override', async () => {
    await approvedLeave(staff[0], '2030-06-01', '2030-06-07');
    await approvedLeave(staff[1], '2030-06-03', '2030-06-10');
    await approvedLeave(staff[2], '2030-06-05', '2030-06-05');

    const res = await submit(staff[3], '2030-06-04', '2030-06-06');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.home_leave_limit_warning.date).toBe('2030-06-05');
    expect(res.body.home_leave_limit_warning.staff_on_leave).toHaveLength(3);

    const prompt = await approve(res.body._id, admin);
    expect(prompt.status).toBe(409);

    const ok = await approve(res.body._id, admin, true);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    const saved = await TimeOffRequest.findById(res.body._id);
    expect(saved.home_leave_limit_override.approved_by.toString()).toBe(admin._id.toString());
  });

  test('non-overlapping days, other homes and sick leave do not trigger the limit', async () => {
    const elsewhere = await createTestUser({ email: email('else'), homes: [{ home_id: otherHome._id }] });
    await approvedLeave(staff[0], '2030-06-01', '2030-06-02');
    await approvedLeave(staff[1], '2030-06-03', '2030-06-04');
    await approvedLeave(staff[2], '2030-06-01', '2030-06-04');
    await approvedLeave(elsewhere, '2030-06-01', '2030-06-04');

    const res = await submit(staff[3], '2030-06-01', '2030-06-04');
    expect(res.body.home_leave_limit_warning).toBeUndefined();

    await approvedLeave(staff[3], '2030-06-01', '2030-06-04');
    const sick = await submit(staff[4], '2030-06-02', '2030-06-02', 'sick_leave');
    expect(sick.body.home_leave_limit_warning).toBeUndefined();
  });

  test('the limit is rechecked on approval when others were approved after submission', async () => {
    const res = await submit(staff[3], '2030-07-01', '2030-07-01');
    expect(res.body.home_leave_limit_warning).toBeUndefined();

    for (const s of staff.slice(0, 3)) await approvedLeave(s, '2030-07-01', '2030-07-01');
    const blocked = await approve(res.body._id, admin);
    expect(blocked.status).toBe(409);
  });

  test('admins can change the limit on the solver rules page', async () => {
    await request(app)
      .put('/api/ai-solver/constraints')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ leave_limit: { max_staff_per_home: 1 } })
      .expect(200);
    expect((await SolverSettings.getSettings()).leave_limit.max_staff_per_home).toBe(1);

    await approvedLeave(staff[0], '2030-08-01', '2030-08-01');
    const res = await submit(staff[1], '2030-08-01', '2030-08-01');
    expect(res.body.home_leave_limit_warning.limit).toBe(1);

    await request(app)
      .put('/api/ai-solver/constraints')
      .set('Authorization', getAuthHeader(keyWorker._id))
      .send({ leave_limit: { max_staff_per_home: 10 } })
      .expect(403);
  });
});

describe('Time-off requests cannot be self-approved', () => {
  let home, worker, colleague, keyWorker, admin;

  beforeEach(async () => {
    home = await createTestHome();
    worker = await createTestUser({ email: email('sw'), homes: [{ home_id: home._id }] });
    colleague = await createTestUser({ email: email('sw'), homes: [{ home_id: home._id }] });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
  });

  const body = (user, extra = {}) => ({
    user_id: user._id.toString(), start_date: '2030-09-01', end_date: '2030-09-02',
    reason: 'Holiday', request_type: 'annual_leave', ...extra
  });

  const create = (as, data) =>
    request(app).post('/api/timeoff').set('Authorization', getAuthHeader(as._id)).send(data);

  test('status and approval fields sent on create are ignored', async () => {
    const res = await create(worker, body(worker, { status: 'approved', approved_by: keyWorker._id.toString() }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.approved_by).toBeUndefined();
  });

  test('staff cannot submit leave for someone else', async () => {
    await create(worker, body(colleague)).expect(403);
  });

  test('editing a request cannot change its status, and only pending requests can be edited', async () => {
    const { body: created } = await create(worker, body(worker));

    const edit = await request(app)
      .put(`/api/timeoff/${created._id}`)
      .set('Authorization', getAuthHeader(worker._id))
      .send({ status: 'approved', reason: 'Family trip' });
    expect(edit.status).toBe(200);
    expect(edit.body.status).toBe('pending');
    expect(edit.body.reason).toBe('Family trip');

    await TimeOffRequest.updateOne({ _id: created._id }, { status: 'approved' });
    await request(app)
      .put(`/api/timeoff/${created._id}`)
      .set('Authorization', getAuthHeader(worker._id))
      .send({ end_date: '2030-09-10' })
      .expect(400);
  });

  test("staff cannot edit or delete a colleague's request, and can only withdraw pending ones", async () => {
    const { body: created } = await create(colleague, body(colleague));
    await request(app).put(`/api/timeoff/${created._id}`).set('Authorization', getAuthHeader(worker._id)).send({ reason: 'x' }).expect(403);
    await request(app).delete(`/api/timeoff/${created._id}`).set('Authorization', getAuthHeader(worker._id)).expect(403);

    await TimeOffRequest.updateOne({ _id: created._id }, { status: 'approved' });
    await request(app).delete(`/api/timeoff/${created._id}`).set('Authorization', getAuthHeader(colleague._id)).expect(400);
    await request(app).delete(`/api/timeoff/${created._id}`).set('Authorization', getAuthHeader(keyWorker._id)).expect(403);
    await request(app).delete(`/api/timeoff/${created._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);
  });

  test('only admins can approve or deny leave', async () => {
    const { body: created } = await create(worker, body(worker));
    for (const role of ['key_worker', 'senior_staff', 'support_worker']) {
      const as = role === 'key_worker' ? keyWorker : await createTestUser({ role, email: email(role), homes: [{ home_id: home._id }] });
      await request(app).post(`/api/timeoff/${created._id}/approve`).set('Authorization', getAuthHeader(as._id)).expect(403);
      await request(app).post(`/api/timeoff/${created._id}/deny`).set('Authorization', getAuthHeader(as._id)).send({ reason: 'No' }).expect(403);
    }
    await request(app).post(`/api/timeoff/${created._id}/deny`).set('Authorization', getAuthHeader(admin._id)).send({ reason: 'Short staffed' }).expect(200);
  });

  test('deleting approved leave frees those days, except days covered by other leave or edited since', async () => {
    const approveAs = (id) => request(app).post(`/api/timeoff/${id}/approve`).set('Authorization', getAuthHeader(admin._id));
    const { body: main } = await create(worker, body(worker, { start_date: '2030-10-01', end_date: '2030-10-04' }));
    const { body: other } = await create(worker, body(worker, { start_date: '2030-10-04', end_date: '2030-10-05' }));
    await approveAs(main._id).expect(200);
    await approveAs(other._id).expect(200);

    // Staff member changed one leave day themselves after approval.
    await Availability.updateOne({ user_id: worker._id, date: '2030-10-02' }, { notes: 'Might come in' });

    await request(app).delete(`/api/timeoff/${main._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);

    const left = (await Availability.find({ user_id: worker._id }).sort({ date: 1 })).map((a) => a.date);
    expect(left).toEqual(['2030-10-02', '2030-10-04', '2030-10-05']);
  });
});
