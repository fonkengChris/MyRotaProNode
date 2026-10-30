// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const Shift = require('../../../models/Shift');
const ShiftSwap = require('../../../models/ShiftSwap');
const TimeOffRequest = require('../../../models/TimeOffRequest');
const ServiceUser = require('../../../models/ServiceUser');
const shiftSwapService = require('../../../services/shiftSwapService');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;
const DAY0 = '2030-03-04';
const DAY1 = '2030-03-05';
const DAY2 = '2030-03-06';
const SUNDAY = '2030-03-10';
const NEXT_MONDAY = '2030-03-11';

const assigned = (userId) => ({ user_id: userId, status: 'assigned' });
const assigneesOf = async (shiftId) =>
  (await Shift.findById(shiftId).lean()).assigned_staff.map((a) => a.user_id.toString());

describe('Shift swaps', () => {
  let home, service, alice, bob, carol;

  const shift = (data) =>
    createTestShift({ home_id: home._id, service_id: service._id, date: DAY1, ...data });
  const requestSwap = (user, body) =>
    request(app).post('/api/shift-swaps').set('Authorization', getAuthHeader(user._id)).send(body);
  const approve = (user, swapId, body = {}) =>
    request(app).post(`/api/shift-swaps/${swapId}/approve`).set('Authorization', getAuthHeader(user._id)).send(body);
  const options = (user) =>
    request(app)
      .get(`/api/shift-swaps/available-shifts/${user._id}`)
      .query({ start_date: DAY0, end_date: SUNDAY })
      .set('Authorization', getAuthHeader(user._id));

  beforeEach(async () => {
    home = await createTestHome({ name: 'Home A' });
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 8, max_staff_count: 5 });
    const member = { homes: [{ home_id: home._id, is_default: true }] };
    alice = await createTestUser({ email: email('alice'), name: 'Alice', ...member });
    bob = await createTestUser({ email: email('bob'), name: 'Bob', ...member });
    carol = await createTestUser({ email: email('carol'), name: 'Carol', ...member });
  });

  test('offers, requests, approves and executes a valid swap', async () => {
    const early = await shift({ start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)] });
    const late = await shift({ start_time: '14:00', end_time: '20:00', assigned_staff: [assigned(bob._id)] });

    const opts = await options(alice);
    expect(opts.status).toBe(200);
    expect(opts.body).toHaveLength(1);
    expect(opts.body[0].potential_swappers.map((s) => String(s.user_id))).toEqual([bob._id.toString()]);

    const created = await requestSwap(alice, { requester_shift_id: early._id, target_shift_id: late._id });
    expect(created.status).toBe(201);
    // Expires no later than the earlier shift's start.
    expect(new Date(created.body.expires_at).getTime()).toBeLessThanOrEqual(new Date(`${DAY1}T08:00:00Z`).getTime());

    const approved = await approve(bob, created.body.id);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('completed');
    expect(await assigneesOf(early._id)).toEqual([bob._id.toString()]);
    expect(await assigneesOf(late._id)).toEqual([alice._id.toString()]);
  });

  test('a rest-rule breach needs both staff to consent, then is flagged for admin review', async () => {
    // Alice works overnight into DAY1 06:00; taking a 09:00 start leaves only 3h rest.
    await createTestShift({
      home_id: home._id, service_id: service._id, date: DAY0,
      start_time: '22:00', end_time: '06:00', shift_type: 'night-wake', assigned_staff: [assigned(alice._id)],
    });
    const evening = await shift({ start_time: '14:00', end_time: '22:00', assigned_staff: [assigned(alice._id)] });
    const morning = await shift({ start_time: '09:00', end_time: '17:00', assigned_staff: [assigned(bob._id)] });

    // Offered, with the warning to consent to.
    const opts = await options(alice);
    const option = opts.body.find((o) => String(o.target_shift.id) === morning._id.toString());
    expect(option.potential_swappers[0].rest_warnings[0]).toMatch(/rest/);

    const body = { requester_shift_id: evening._id, target_shift_id: morning._id };
    const noConsent = await requestSwap(alice, body);
    expect(noConsent.status).toBe(409);
    expect(noConsent.body.consent_required).toBe(true);

    const created = await requestSwap(alice, { ...body, rest_consent: true });
    expect(created.status).toBe(201);
    expect(created.body.rest_warnings).toHaveLength(1);

    const targetNoConsent = await approve(bob, created.body.id);
    expect(targetNoConsent.status).toBe(409);
    expect(targetNoConsent.body.consent_required).toBe(true);

    const approved = await approve(bob, created.body.id, { rest_consent: true });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('completed');
    const onMorning = (await Shift.findById(morning._id).lean()).assigned_staff[0];
    expect(onMorning.user_id.toString()).toBe(alice._id.toString());
    expect(onMorning.rest_exception_status).toBe('pending');
    const onEvening = (await Shift.findById(evening._id).lean()).assigned_staff[0];
    expect(onEvening.rest_exception_status).toBe('none');
  });

  test('swaps across days within the same week', async () => {
    const monday = await createTestShift({
      home_id: home._id, service_id: service._id, date: DAY0, start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)],
    });
    const wednesday = await createTestShift({
      home_id: home._id, service_id: service._id, date: DAY2, start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(bob._id)],
    });

    const opts = await options(alice);
    expect(opts.body.map((o) => String(o.target_shift.id))).toEqual([wednesday._id.toString()]);
    const created = await requestSwap(alice, { requester_shift_id: monday._id, target_shift_id: wednesday._id });
    expect(created.status).toBe(201);
  });

  test('rejects shifts in different weeks, homes, or with unequal paid hours', async () => {
    const mine = await createTestShift({
      home_id: home._id, service_id: service._id, date: SUNDAY, start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)],
    });
    const nextWeek = await createTestShift({
      home_id: home._id, service_id: service._id, date: NEXT_MONDAY, start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(bob._id)],
    });
    // 14:00–22:00 is 8h, less the default 30-minute break = 7.5h paid vs 6h.
    const longer = await createTestShift({
      home_id: home._id, service_id: service._id, date: SUNDAY, start_time: '14:00', end_time: '22:00', assigned_staff: [assigned(carol._id)],
    });
    const otherHome = await createTestHome({ name: 'Home B' });
    const elsewhere = await createTestShift({
      home_id: otherHome._id, service_id: service._id, date: SUNDAY, start_time: '14:00', end_time: '20:00', assigned_staff: [assigned(bob._id)],
    });

    const typesFor = async (target) =>
      (await requestSwap(alice, { requester_shift_id: mine._id, target_shift_id: target._id })).body.conflicts.map((c) => c.type);
    expect(await typesFor(nextWeek)).toContain('different_week');
    expect(await typesFor(longer)).toContain('unequal_hours');
    expect(await typesFor(elsewhere)).toContain('different_home');
    expect((await options(alice)).body).toHaveLength(0);
  });

  test('blocks 1-to-1 shifts', async () => {
    const mine = await shift({ start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)] });
    const serviceUser = await ServiceUser.create({ name: 'Alex', home_id: home._id });
    const oneToOne = await shift({
      start_time: '14:00', end_time: '20:00', shift_type: 'one_to_one', service_user_id: serviceUser._id,
      assigned_staff: [assigned(bob._id)],
    });

    const res = await requestSwap(alice, { requester_shift_id: mine._id, target_shift_id: oneToOne._id });
    expect(res.status).toBe(409);
    expect(res.body.conflicts.map((c) => c.type)).toContain('one_to_one_shift');
    expect((await options(alice)).body).toHaveLength(0);
  });

  test('blocks shifts that have already started', async () => {
    const past = { home_id: home._id, service_id: service._id, date: '2020-01-01' };
    const mine = await createTestShift({ ...past, start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)] });
    const theirs = await createTestShift({ ...past, start_time: '14:00', end_time: '20:00', assigned_staff: [assigned(bob._id)] });

    const res = await requestSwap(alice, { requester_shift_id: mine._id, target_shift_id: theirs._id });
    expect(res.status).toBe(409);
    expect(res.body.conflicts.map((c) => c.type)).toContain('shift_started');
  });

  test('pending leave on the second day of an overnight shift blocks the swap', async () => {
    const mine = await createTestShift({
      home_id: home._id, service_id: service._id, date: DAY0,
      start_time: '20:00', end_time: '08:00', shift_type: 'night-wake', assigned_staff: [assigned(alice._id)],
    });
    const night = await shift({ start_time: '20:00', end_time: '08:00', shift_type: 'night-wake', assigned_staff: [assigned(bob._id)] });
    await TimeOffRequest.create({
      user_id: alice._id, start_date: DAY2, end_date: DAY2, reason: 'Trip', request_type: 'annual_leave', status: 'pending',
    });

    const res = await requestSwap(alice, { requester_shift_id: mine._id, target_shift_id: night._id });
    expect(res.status).toBe(409);
    expect(res.body.conflicts.map((c) => c.type)).toContain('time_off_conflict');
  });

  test('expired requests stop blocking and show as expired', async () => {
    const mine = await shift({ start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)] });
    const theirs = await shift({ start_time: '14:00', end_time: '20:00', assigned_staff: [assigned(bob._id)] });
    const stale = await ShiftSwap.create({
      requester_shift_id: mine._id, target_shift_id: theirs._id, requester_id: alice._id,
      target_user_id: bob._id, home_id: home._id, expires_at: new Date(Date.now() - 1000),
    });

    const res = await requestSwap(alice, { requester_shift_id: mine._id, target_shift_id: theirs._id });
    expect(res.status).toBe(201);
    expect((await ShiftSwap.findById(stale._id)).status).toBe('expired');

    const history = await request(app)
      .get('/api/shift-swaps')
      .query({ status: 'completed,approved,rejected,cancelled,expired' })
      .set('Authorization', getAuthHeader(alice._id));
    expect(history.body.map((s) => s.id)).toEqual([stale._id.toString()]);

    const stats = await request(app).get(`/api/shift-swaps/stats/${alice._id}`).set('Authorization', getAuthHeader(alice._id));
    expect(stats.body).toMatchObject({ total: 2, pending: 1, expired: 1 });
  });

  test('swaps with the chosen colleague when the target shift has several', async () => {
    const mine = await shift({ start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)] });
    const theirs = await shift({ start_time: '14:00', end_time: '20:00', assigned_staff: [assigned(bob._id), assigned(carol._id)] });

    const ambiguous = await requestSwap(alice, { requester_shift_id: mine._id, target_shift_id: theirs._id });
    expect(ambiguous.status).toBe(400);

    const res = await requestSwap(alice, { requester_shift_id: mine._id, target_shift_id: theirs._id, target_user_id: carol._id });
    expect(res.status).toBe(201);
    expect(String(res.body.target_user_id.id || res.body.target_user_id._id)).toBe(carol._id.toString());
  });

  test('execution changes nothing when the rota no longer allows the swap', async () => {
    const mine = await shift({ start_time: '08:00', end_time: '14:00', assigned_staff: [assigned(alice._id)] });
    const theirs = await shift({ start_time: '14:00', end_time: '20:00', assigned_staff: [assigned(bob._id)] });
    const swap = await ShiftSwap.create({
      requester_shift_id: mine._id, target_shift_id: theirs._id, requester_id: alice._id,
      target_user_id: bob._id, home_id: home._id, status: 'approved',
    });
    // Rota changed after approval: Alice is now also on the target shift, so the second
    // half of the swap can't apply and the first half must be rolled back.
    await Shift.updateOne({ _id: theirs._id }, { $push: { assigned_staff: assigned(alice._id) } });

    await expect(shiftSwapService.executeSwap(swap._id)).rejects.toBeInstanceOf(shiftSwapService.SwapExecutionError);
    expect(await assigneesOf(mine._id)).toEqual([alice._id.toString()]);
    expect((await assigneesOf(theirs._id)).sort()).toEqual([alice._id.toString(), bob._id.toString()].sort());
  });
});
