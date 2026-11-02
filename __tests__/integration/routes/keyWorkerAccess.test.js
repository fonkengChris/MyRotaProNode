// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';
// This suite makes more requests than the API limiter allows per window.
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';

const request = require('supertest');
const app = require('../../../server');
const User = require('../../../models/User');
const Rota = require('../../../models/Rota');
const WeeklySchedule = require('../../../models/WeeklySchedule');
const KeyWorkerAccessSettings = require('../../../models/KeyWorkerAccessSettings');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('key worker access', () => {
  let admin, keyWorker, peer, worker, otherWorker, homeA, homeB, service;

  const as = (user) => ({ Authorization: getAuthHeader(user._id) });
  const setAccess = async (values) => {
    const settings = await KeyWorkerAccessSettings.getSettings();
    settings.set(values);
    await settings.save();
  };

  beforeEach(async () => {
    homeA = await createTestHome({ name: 'Home A' });
    homeB = await createTestHome({ name: 'Home B' });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: homeA._id }] });
    peer = await createTestUser({ role: 'key_worker', email: email('peer'), homes: [{ home_id: homeA._id }] });
    worker = await createTestUser({ email: email('sw'), homes: [{ home_id: homeA._id }] });
    otherWorker = await createTestUser({ email: email('other'), homes: [{ home_id: homeB._id }] });
    service = await createTestService({ home_id: homeA._id, category: 'personal_care', duration_hours: 8, max_staff_count: 5 });
  });

  describe('settings', () => {
    test('defaults: full on staff, schedules and rota; personal pages hidden; all homes', async () => {
      const res = await request(app).get('/api/auth/me').set(as(keyWorker)).expect(200);
      expect(res.body.user.access).toEqual({
        staff: 'full',
        weekly_schedules: 'full',
        rota: 'full',
        shift_selection: 'hidden',
        shift_swaps: 'hidden',
        my_hours: 'hidden',
        home_scope: 'all',
      });
    });

    test('login returns effective access for key workers only', async () => {
      const login = (user) => request(app).post('/api/auth/login').send({ email: user.email, password: 'TestPassword123' });
      expect((await login(keyWorker)).body.user.access.rota).toBe('full');
      expect((await login(worker)).body.user.access).toBeUndefined();
    });

    test('only admins can read, change or reset the settings', async () => {
      await request(app).get('/api/key-worker-access').set(as(keyWorker)).expect(403);
      await request(app).put('/api/key-worker-access').set(as(keyWorker)).send({ rota: 'full' }).expect(403);
      await request(app).post('/api/key-worker-access/reset').set(as(worker)).expect(403);

      const res = await request(app).put('/api/key-worker-access').set(as(admin)).send({ rota: 'view' }).expect(200);
      expect(res.body.settings.rota).toBe('view');
      const me = await request(app).get('/api/auth/me').set(as(keyWorker)).expect(200);
      expect(me.body.user.access.rota).toBe('view');

      const reset = await request(app).post('/api/key-worker-access/reset').set(as(admin)).expect(200);
      expect(reset.body.settings.rota).toBe('full');
    });

    test('rejects invalid values and ignores unknown fields', async () => {
      await request(app).put('/api/key-worker-access').set(as(admin)).send({ rota: 'owner' }).expect(400);
      const res = await request(app).put('/api/key-worker-access').set(as(admin)).send({ pay: 'full' }).expect(200);
      expect(res.body.settings.pay).toBeUndefined();
    });
  });

  describe('per-person overrides', () => {
    const override = (user, body, by = admin) =>
      request(app).put(`/api/users/${user._id}/key-worker-access`).set(as(by)).send(body);

    test('an override beats the default for that key worker only', async () => {
      await override(keyWorker, { rota: 'hidden', shift_swaps: 'visible' }).expect(200);
      const mine = await request(app).get('/api/auth/me').set(as(keyWorker));
      expect(mine.body.user.access.rota).toBe('hidden');
      expect(mine.body.user.access.shift_swaps).toBe('visible');
      const theirs = await request(app).get('/api/auth/me').set(as(peer));
      expect(theirs.body.user.access.rota).toBe('full');
    });

    test('clearing an override returns to the default', async () => {
      await override(keyWorker, { rota: 'hidden' }).expect(200);
      await override(keyWorker, { rota: '' }).expect(200);
      const me = await request(app).get('/api/auth/me').set(as(keyWorker));
      expect(me.body.user.access.rota).toBe('full');
    });

    test('is admin-only, key-worker-only and validated', async () => {
      await override(keyWorker, { rota: 'full' }, keyWorker).expect(403);
      await override(worker, { rota: 'full' }).expect(400);
      await override(keyWorker, { rota: 'owner' }).expect(400);
    });

    test('key workers cannot set overrides through the profile route', async () => {
      await request(app).put(`/api/users/${keyWorker._id}`).set(as(keyWorker))
        .send({ key_worker_access: { staff: 'full' }, $set: { 'key_worker_access.staff': 'full' } }).expect(200);
      const saved = await User.findById(keyWorker._id).select('+key_worker_access');
      expect(saved.key_worker_access).toBeUndefined();
    });

    test('overrides are only returned to admins', async () => {
      await override(keyWorker, { rota: 'view' }).expect(200);
      const byPeer = await request(app).get(`/api/users/${keyWorker._id}`).set(as(peer)).expect(200);
      expect(byPeer.body.key_worker_access).toBeUndefined();
      const byAdmin = await request(app).get(`/api/users/${keyWorker._id}`).set(as(admin)).expect(200);
      expect(byAdmin.body.key_worker_access.rota).toBe('view');
    });
  });

  describe('privilege escalation', () => {
    const roleOf = async (user) => (await User.findById(user._id)).role;

    test('a key worker cannot make themselves admin', async () => {
      await request(app).put(`/api/users/${keyWorker._id}`).set(as(keyWorker)).send({ role: 'admin' }).expect(200);
      expect(await roleOf(keyWorker)).toBe('key_worker');
    });

    test.each([
      ['role', { $set: { role: 'admin' } }, async (u) => u.role, 'support_worker'],
      ['pay', { $set: { hourly_rate: 99 } }, async (u) => u.hourly_rate, 12.71],
    ])('$set cannot change %s on your own account', async (_, body, read, expected) => {
      await request(app).put(`/api/users/${worker._id}`).set(as(worker)).send(body).expect(200);
      expect(await read(await User.findById(worker._id).select('+hourly_rate'))).toBe(expected);
    });

    test('$set cannot change a password', async () => {
      const before = (await User.findById(worker._id).select('+password')).password;
      await request(app).put(`/api/users/${worker._id}`).set(as(worker)).send({ $set: { password: 'x'.repeat(60) } }).expect(200);
      expect((await User.findById(worker._id).select('+password')).password).toBe(before);
    });

    test('staff cannot change their own contract fields, homes or active status', async () => {
      await request(app).put(`/api/users/${keyWorker._id}`).set(as(keyWorker))
        .send({ name: 'New Name', is_active: false, max_hours_per_week: 1, homes: [{ home_id: homeB._id }] }).expect(200);
      const saved = await User.findById(keyWorker._id);
      expect(saved.name).toBe('New Name');
      expect(saved.is_active).toBe(true);
      expect(saved.max_hours_per_week).not.toBe(1);
      expect(saved.homes.map((h) => String(h.home_id))).toEqual([String(homeA._id)]);
    });

    test('a key worker cannot add themselves to a home', async () => {
      await request(app).post(`/api/users/${keyWorker._id}/add-home`).set(as(keyWorker)).send({ home_id: homeB._id }).expect(403);
    });

    test.each([['admin'], ['key_worker']])('a key worker cannot grant the %s role', async (role) => {
      await request(app).put(`/api/users/${worker._id}`).set(as(keyWorker)).send({ role }).expect(403);
      expect(await roleOf(worker)).toBe('support_worker');
    });

    test('a key worker can move staff between the other roles, but not change a peer\'s role', async () => {
      await request(app).put(`/api/users/${worker._id}`).set(as(keyWorker)).send({ role: 'senior_staff' }).expect(200);
      expect(await roleOf(worker)).toBe('senior_staff');
      await request(app).put(`/api/users/${peer._id}`).set(as(keyWorker)).send({ role: 'support_worker' }).expect(403);
    });

    test('resending a peer\'s unchanged role is not a role change', async () => {
      await request(app).put(`/api/users/${peer._id}`).set(as(keyWorker)).send({ role: 'key_worker', name: 'Renamed' }).expect(200);
    });

    test('pay stays admin-only', async () => {
      await request(app).put(`/api/users/${worker._id}`).set(as(keyWorker)).send({ hourly_rate: 99 }).expect(200);
      const saved = await User.findById(worker._id).select('+hourly_rate');
      expect(saved.hourly_rate).toBe(12.71);
      const created = await request(app).post('/api/users').set(as(keyWorker)).send({
        name: 'New', email: email('new'), phone: '+1234567890', password: 'TestPassword123', role: 'support_worker', hourly_rate: 99,
      }).expect(201);
      expect((await User.findById(created.body.id).select('+hourly_rate')).hourly_rate).toBe(12.71);
      const listed = await request(app).get('/api/users').set(as(keyWorker)).expect(200);
      expect(listed.body.every((u) => u.hourly_rate === undefined)).toBe(true);
    });

    test('admin accounts are protected from key workers', async () => {
      await request(app).put(`/api/users/${admin._id}`).set(as(keyWorker)).send({ name: 'x' }).expect(403);
      await request(app).post(`/api/users/${admin._id}/deactivate`).set(as(keyWorker)).expect(403);
      await request(app).delete(`/api/users/${admin._id}`).set(as(keyWorker)).expect(403);
      await request(app).post(`/api/users/${admin._id}/add-home`).set(as(keyWorker)).send({ home_id: homeA._id }).expect(403);
    });

    test('key workers cannot remove other key workers or themselves', async () => {
      await request(app).delete(`/api/users/${peer._id}`).set(as(keyWorker)).expect(403);
      await request(app).post(`/api/users/${peer._id}/deactivate`).set(as(keyWorker)).expect(403);
      await request(app).put(`/api/users/${peer._id}`).set(as(keyWorker)).send({ is_active: false }).expect(403);
      await request(app).delete(`/api/users/${keyWorker._id}`).set(as(keyWorker)).expect(403);
      await request(app).post(`/api/users/${keyWorker._id}/deactivate`).set(as(keyWorker)).expect(403);
    });

    test.each([['admin'], ['key_worker']])('a key worker cannot create a %s', async (role) => {
      await request(app).post('/api/users').set(as(keyWorker)).send({
        name: 'New', email: email('new'), phone: '+1234567890', password: 'TestPassword123', role,
      }).expect(403);
    });
  });

  describe('staff levels', () => {
    const newStaff = (home) => ({
      name: 'New', email: email('new'), phone: '+1234567890', password: 'TestPassword123', role: 'support_worker', home_id: home._id,
    });

    test('full: add, edit, deactivate and delete staff in any home by default', async () => {
      await request(app).post('/api/users').set(as(keyWorker)).send(newStaff(homeB)).expect(201);
      await request(app).put(`/api/users/${otherWorker._id}`).set(as(keyWorker)).send({ name: 'Edited' }).expect(200);
      await request(app).post(`/api/users/${otherWorker._id}/deactivate`).set(as(keyWorker)).expect(200);
      await request(app).delete(`/api/users/${otherWorker._id}`).set(as(keyWorker)).expect(200);
    });

    test.each([['view'], ['hidden']])('%s: refuses every write', async (level) => {
      await setAccess({ staff: level });
      await request(app).post('/api/users').set(as(keyWorker)).send(newStaff(homeA)).expect(403);
      await request(app).put(`/api/users/${worker._id}`).set(as(keyWorker)).send({ name: 'x' }).expect(403);
      await request(app).post(`/api/users/${worker._id}/deactivate`).set(as(keyWorker)).expect(403);
      await request(app).delete(`/api/users/${worker._id}`).set(as(keyWorker)).expect(403);
      await request(app).post(`/api/users/${worker._id}/add-home`).set(as(keyWorker)).send({ home_id: homeA._id }).expect(403);
    });

    test('hidden staff still lets a key worker edit their own profile', async () => {
      await setAccess({ staff: 'hidden' });
      await request(app).put(`/api/users/${keyWorker._id}`).set(as(keyWorker)).send({ name: 'Me' }).expect(200);
    });

    test('own scope limits reads and writes to their homes', async () => {
      await setAccess({ home_scope: 'own' });
      await request(app).get(`/api/users?home_id=${homeB._id}`).set(as(keyWorker)).expect(403);
      await request(app).get(`/api/users/${otherWorker._id}`).set(as(keyWorker)).expect(403);
      await request(app).put(`/api/users/${otherWorker._id}`).set(as(keyWorker)).send({ name: 'x' }).expect(403);
      await request(app).delete(`/api/users/${otherWorker._id}`).set(as(keyWorker)).expect(403);
      await request(app).post('/api/users').set(as(keyWorker)).send(newStaff(homeB)).expect(403);
      await request(app).post(`/api/users/${worker._id}/add-home`).set(as(keyWorker)).send({ home_id: homeB._id }).expect(403);
      await request(app).put(`/api/users/${worker._id}`).set(as(keyWorker)).send({ name: 'ok' }).expect(200);
    });

    test('regular staff gain nothing', async () => {
      await request(app).get(`/api/users/${otherWorker._id}`).set(as(worker)).expect(403);
      await request(app).delete(`/api/users/${otherWorker._id}`).set(as(worker)).expect(403);
      await request(app).post('/api/users').set(as(worker)).send(newStaff(homeA)).expect(403);
      const homes = await request(app).get('/api/homes').set(as(worker)).expect(200);
      expect(homes.body.map((h) => h.name)).toEqual(['Home A']);
    });
  });

  describe('weekly schedule levels', () => {
    const emptySchedule = (home) => ({ home_id: home._id });

    test('full: create, update and delete, in any home by default', async () => {
      const created = await request(app).post('/api/weekly-schedules').set(as(keyWorker)).send(emptySchedule(homeB)).expect(201);
      await request(app).put(`/api/weekly-schedules/${created.body._id}`).set(as(keyWorker)).send({ is_active: true }).expect(200);
      await request(app).get('/api/weekly-schedules').set(as(keyWorker)).expect(200);
      await request(app).delete(`/api/weekly-schedules/${created.body._id}`).set(as(keyWorker)).expect(200);
    });

    test('update cannot move a schedule to another home or use $ operators', async () => {
      const schedule = await WeeklySchedule.create(emptySchedule(homeA));
      await request(app).put(`/api/weekly-schedules/${schedule._id}`).set(as(keyWorker))
        .send({ home_id: homeB._id, $set: { home_id: homeB._id } }).expect(200);
      expect(String((await WeeklySchedule.findById(schedule._id)).home_id)).toBe(String(homeA._id));
    });

    test('view: reads but no writes', async () => {
      await setAccess({ weekly_schedules: 'view' });
      const schedule = await WeeklySchedule.create(emptySchedule(homeA));
      await request(app).get(`/api/weekly-schedules/home/${homeA._id}`).set(as(keyWorker)).expect(200);
      await request(app).post('/api/weekly-schedules').set(as(keyWorker)).send(emptySchedule(homeB)).expect(403);
      await request(app).put(`/api/weekly-schedules/${schedule._id}`).set(as(keyWorker)).send({ is_active: true }).expect(403);
      await request(app).delete(`/api/weekly-schedules/${schedule._id}`).set(as(keyWorker)).expect(403);
      await request(app).patch(`/api/weekly-schedules/${schedule._id}/days/monday/toggle`).set(as(keyWorker)).expect(403);
    });

    test('own scope blocks other homes', async () => {
      await setAccess({ home_scope: 'own' });
      const schedule = await WeeklySchedule.create(emptySchedule(homeB));
      await request(app).get(`/api/weekly-schedules/home/${homeB._id}`).set(as(keyWorker)).expect(403);
      await request(app).put(`/api/weekly-schedules/${schedule._id}`).set(as(keyWorker)).send({ is_active: true }).expect(403);
      await request(app).patch(`/api/weekly-schedules/${schedule._id}/days/monday/toggle`).set(as(keyWorker)).expect(403);
      const list = await request(app).get('/api/weekly-schedules').set(as(keyWorker)).expect(200);
      expect(list.body).toHaveLength(0);
    });
  });

  describe('rota levels', () => {
    const rotaFor = (home) => Rota.create({
      home_id: home._id, service_id: service._id, week_start_date: '2030-01-07', week_end_date: '2030-01-13', created_by: admin._id,
    });
    const shiftIn = (home) => createTestShift({ home_id: home._id, service_id: service._id });

    test('full: edit shifts and rotas in any home by default', async () => {
      const shift = await shiftIn(homeB);
      const rota = await rotaFor(homeB);
      await request(app).put(`/api/shifts/${shift._id}`).set(as(keyWorker)).send({ notes: 'x' }).expect(200);
      await request(app).post(`/api/rotas/${rota._id}/publish`).set(as(keyWorker)).expect(200);
      await request(app).delete(`/api/shifts/${shift._id}`).set(as(keyWorker)).expect(200);
    });

    test('view: reads but no writes', async () => {
      await setAccess({ rota: 'view' });
      const shift = await shiftIn(homeA);
      const rota = await rotaFor(homeA);
      await request(app).get(`/api/rotas/${rota._id}`).set(as(keyWorker)).expect(200);
      await request(app).put(`/api/shifts/${shift._id}`).set(as(keyWorker)).send({ notes: 'x' }).expect(403);
      await request(app).delete(`/api/shifts/${shift._id}`).set(as(keyWorker)).expect(403);
      await request(app).post(`/api/shifts/${shift._id}/assign`).set(as(keyWorker)).send({ user_id: worker._id }).expect(403);
      await request(app).post(`/api/rotas/${rota._id}/publish`).set(as(keyWorker)).expect(403);
      await request(app).delete(`/api/rotas/${rota._id}`).set(as(keyWorker)).expect(403);
      await request(app).post('/api/ai-solver/generate-rota').set(as(keyWorker)).send({}).expect(403);
    });

    test('own scope blocks other homes', async () => {
      await setAccess({ home_scope: 'own' });
      const shift = await shiftIn(homeB);
      const rota = await rotaFor(homeB);
      await request(app).get(`/api/rotas/${rota._id}`).set(as(keyWorker)).expect(403);
      await request(app).put(`/api/rotas/${rota._id}`).set(as(keyWorker)).send({ notes: 'x' }).expect(403);
      await request(app).post(`/api/rotas/${rota._id}/publish`).set(as(keyWorker)).expect(403);
      await request(app).delete(`/api/rotas/${rota._id}`).set(as(keyWorker)).expect(403);
      await request(app).put(`/api/shifts/${shift._id}`).set(as(keyWorker)).send({ notes: 'x' }).expect(403);
      await request(app).post(`/api/shifts/${shift._id}/assign`).set(as(keyWorker)).send({ user_id: otherWorker._id }).expect(403);
      await request(app).get(`/api/shifts?home_id=${homeB._id}`).set(as(keyWorker)).expect(403);
      await request(app).post('/api/shifts').set(as(keyWorker)).send({ home_id: homeB._id, service_id: service._id }).expect(403);
    });

    test('own scope stops a shift being moved into another home', async () => {
      await setAccess({ home_scope: 'own' });
      const shift = await shiftIn(homeA);
      await request(app).put(`/api/shifts/${shift._id}`).set(as(keyWorker)).send({ home_id: homeB._id }).expect(403);
    });

    test('a rota update cannot move it to another home', async () => {
      const rota = await rotaFor(homeA);
      await request(app).put(`/api/rotas/${rota._id}`).set(as(keyWorker)).send({ home_id: homeB._id, notes: 'x' }).expect(200);
      const saved = await Rota.findById(rota._id);
      expect(String(saved.home_id)).toBe(String(homeA._id));
      expect(saved.notes).toBe('x');
    });

    test('a key worker\'s own shifts stay readable whatever the rota level', async () => {
      await setAccess({ rota: 'hidden' });
      const res = await request(app).get(`/api/shifts?user_id=${keyWorker._id}`).set(as(keyWorker)).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('hidden rota does not widen reach to other homes', async () => {
      await setAccess({ rota: 'hidden' });
      await request(app).get(`/api/shifts?home_id=${homeB._id}`).set(as(keyWorker)).expect(403);
    });

    test('key workers still cannot use admin rule overrides', async () => {
      const shift = await shiftIn(homeA);
      await request(app).get('/api/shifts/hours-cap-exceptions').set(as(keyWorker)).expect(403);
      await request(app).post(`/api/shifts/${shift._id}/hours-cap-exception/${worker._id}/confirm`).set(as(keyWorker)).expect(403);
    });
  });

  describe('personal pages', () => {
    const available = (user) => request(app)
      .get(`/api/shifts/available?user_id=${user._id}&start_date=2030-01-07&end_date=2030-01-13`)
      .set(as(user));

    test('shift selection: blocked when hidden, allowed when visible', async () => {
      await available(keyWorker).expect(403);
      await request(app).put(`/api/users/${keyWorker._id}/key-worker-access`).set(as(admin)).send({ shift_selection: 'visible' }).expect(200);
      await available(keyWorker).expect(200);
      await available(worker).expect(200);
    });

    test('self-assign needs full rota access or shift selection', async () => {
      const shift = await createTestShift({ home_id: homeA._id, service_id: service._id });
      await setAccess({ rota: 'view' });
      await request(app).post(`/api/shifts/${shift._id}/assign`).set(as(keyWorker)).send({ user_id: keyWorker._id }).expect(403);
      await request(app).put(`/api/users/${keyWorker._id}/key-worker-access`).set(as(admin)).send({ shift_selection: 'visible' }).expect(200);
      await request(app).post(`/api/shifts/${shift._id}/assign`).set(as(keyWorker)).send({ user_id: keyWorker._id }).expect(200);
    });

    test('shift swaps: a key worker with swaps hidden can neither request nor be chosen', async () => {
      const shiftA = await createTestShift({ home_id: homeA._id, service_id: service._id, date: '2030-01-07', assigned_staff: [{ user_id: keyWorker._id }] });
      const shiftB = await createTestShift({ home_id: homeA._id, service_id: service._id, date: '2030-01-08', assigned_staff: [{ user_id: worker._id }] });
      await request(app).post('/api/shift-swaps').set(as(keyWorker))
        .send({ requester_shift_id: shiftA._id, target_shift_id: shiftB._id }).expect(403);
      const res = await request(app).post('/api/shift-swaps').set(as(worker))
        .send({ requester_shift_id: shiftB._id, target_shift_id: shiftA._id }).expect(400);
      expect(res.body.error).toMatch(/not taking shift swaps/);
    });

    test('shift swaps: hidden key workers are left out of swap options', async () => {
      await createTestShift({ home_id: homeA._id, service_id: service._id, date: '2030-01-07', start_time: '08:00', end_time: '16:00', assigned_staff: [{ user_id: worker._id }] });
      await createTestShift({ home_id: homeA._id, service_id: service._id, date: '2030-01-08', start_time: '08:00', end_time: '16:00', assigned_staff: [{ user_id: keyWorker._id }] });
      const res = await request(app)
        .get(`/api/shift-swaps/available-shifts/${worker._id}?home_id=${homeA._id}`)
        .set(as(worker))
        .expect(200);
      const names = JSON.stringify(res.body);
      expect(names).not.toContain(String(keyWorker._id));
    });
  });

  describe('homes and services follow scope', () => {
    test('all homes by default, own homes when scoped', async () => {
      const all = await request(app).get('/api/homes').set(as(keyWorker)).expect(200);
      expect(all.body).toHaveLength(2);
      await setAccess({ home_scope: 'own' });
      const own = await request(app).get('/api/homes').set(as(keyWorker)).expect(200);
      expect(own.body.map((h) => h.name)).toEqual(['Home A']);
    });

    test('all three areas hidden means own homes only, even with all-homes scope', async () => {
      await setAccess({ staff: 'hidden', weekly_schedules: 'hidden', rota: 'hidden' });
      const res = await request(app).get('/api/homes').set(as(keyWorker)).expect(200);
      expect(res.body.map((h) => h.name)).toEqual(['Home A']);
    });
  });
});
