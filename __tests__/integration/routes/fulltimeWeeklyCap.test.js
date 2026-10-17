// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const Shift = require('../../../models/Shift');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

// Monday to Saturday of one Monday-to-Sunday cap week.
const DAYS = ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08', '2030-03-09'];

describe('Full-time weekly cap (48 paid hours after breaks, admin only above it)', () => {
  let admin, keyWorker, worker, home, service;

  beforeEach(async () => {
    // Default break policy: 8h+ shifts lose 0.5h, 12h+ shifts lose 1h.
    home = await createTestHome();
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 12, max_staff_count: 5 });
    admin = await createTestUser({ role: 'admin', email: email('admin') });
    keyWorker = await createTestUser({ role: 'key_worker', email: email('kw'), homes: [{ home_id: home._id }] });
    worker = await createTestUser({ email: email('sw'), type: 'fulltime', homes: [{ home_id: home._id }] });

    // Four 12h day shifts: 48h rostered, 44h paid after breaks.
    for (const date of DAYS.slice(0, 4)) {
      await createTestShift({
        home_id: home._id, service_id: service._id, date, start_time: '08:00', end_time: '20:00',
        assigned_staff: [{ user_id: worker._id, status: 'assigned' }]
      });
    }
  });

  const shortShift = (date) => createTestShift({
    home_id: home._id, service_id: service._id, date, start_time: '09:00', end_time: '13:00'
  });

  const assign = (shift, as, override) =>
    request(app)
      .post(`/api/shifts/${shift._id}/assign`)
      .set('Authorization', getAuthHeader(as._id))
      .send({ user_id: worker._id.toString(), override });

  const assignmentOf = async (shift) =>
    (await Shift.findById(shift._id)).assigned_staff.find((a) => a.user_id.toString() === worker._id.toString());

  test('hours are counted after breaks, so reaching exactly 48h is allowed', async () => {
    // 44h + 4h = 48h paid (52h before breaks).
    const res = await assign(await shortShift(DAYS[4]), keyWorker);
    expect(res.status).toBe(200);
  });

  test('a key worker cannot take a full-timer above 48h', async () => {
    await assign(await shortShift(DAYS[4]), keyWorker).expect(200);
    const res = await assign(await shortShift(DAYS[5]), keyWorker);
    expect(res.status).toBe(409);
    expect(res.body.overridableConflicts.map((c) => c.conflictType)).toContain('fulltime_weekly_cap_exceeded');
    expect(res.body.overridable).toBe(false);
  });

  test('an admin must confirm before assigning above 48h, and the approval is recorded', async () => {
    await assign(await shortShift(DAYS[4]), admin).expect(200);
    const over = await shortShift(DAYS[5]);

    const prompt = await assign(over, admin);
    expect(prompt.status).toBe(409);
    expect(prompt.body.overridable).toBe(true);
    const cap = prompt.body.overridableConflicts.find((c) => c.conflictType === 'fulltime_weekly_cap_exceeded');
    expect(cap.details.projected_weekly_hours).toBe(52);

    await assign(over, admin, true).expect(200);
    const assignment = await assignmentOf(over);
    expect(assignment.hours_cap_exception_status).toBe('confirmed');
    expect(assignment.hours_cap_exception_hours).toBe(52);
  });

  test('a key worker cannot override the cap even when asking to', async () => {
    await assign(await shortShift(DAYS[4]), keyWorker).expect(200);
    await assign(await shortShift(DAYS[5]), keyWorker, true).expect(409);
  });

  describe('support worker selecting a shift over the cap', () => {
    let over;

    beforeEach(async () => {
      await assign(await shortShift(DAYS[4]), admin).expect(200);
      over = await shortShift(DAYS[5]);
    });

    test('is held for them pending admin approval', async () => {
      const res = await assign(over, worker);
      expect(res.status).toBe(200);
      expect(res.body.hours_cap_exception_pending).toBe(true);

      const assignment = await assignmentOf(over);
      expect(assignment.hours_cap_exception_status).toBe('pending');
      expect(assignment.hours_cap_exception_hours).toBe(52);

      const list = await request(app).get('/api/shifts/hours-cap-exceptions')
        .set('Authorization', getAuthHeader(admin._id)).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].projected_weekly_hours).toBe(52);
    });

    test('only admins review the request', async () => {
      await assign(over, worker).expect(200);
      const kw = getAuthHeader(keyWorker._id);
      await request(app).get('/api/shifts/hours-cap-exceptions').set('Authorization', kw).expect(403);
      await request(app).post(`/api/shifts/${over._id}/hours-cap-exception/${worker._id}/confirm`)
        .set('Authorization', kw).expect(403);
    });

    test('admin approval keeps the shift', async () => {
      await assign(over, worker).expect(200);
      await request(app).post(`/api/shifts/${over._id}/hours-cap-exception/${worker._id}/confirm`)
        .set('Authorization', getAuthHeader(admin._id)).expect(200);
      expect((await assignmentOf(over)).hours_cap_exception_status).toBe('confirmed');
    });

    test('cannot be clocked into until approved', async () => {
      await assign(over, worker).expect(200);
      const blocked = await request(app).post(`/api/shifts/${over._id}/clock-in`)
        .set('Authorization', getAuthHeader(worker._id)).expect(409);
      expect(blocked.body.pending_approval).toBe(true);
      // A manager clocking them in is blocked too.
      await request(app).post(`/api/shifts/${over._id}/clock-in`)
        .set('Authorization', getAuthHeader(admin._id)).send({ user_id: worker._id.toString() }).expect(409);

      await request(app).post(`/api/shifts/${over._id}/hours-cap-exception/${worker._id}/confirm`)
        .set('Authorization', getAuthHeader(admin._id)).expect(200);
      const after = await request(app).post(`/api/shifts/${over._id}/clock-in`)
        .set('Authorization', getAuthHeader(worker._id));
      expect(after.body.pending_approval).toBeUndefined(); // now only the time window applies
    });

    test('the selection preview matches what assigning does', async () => {
      const fine = await createTestShift({
        home_id: home._id, service_id: service._id, date: '2030-03-11', start_time: '09:00', end_time: '13:00'
      });
      const clash = await createTestShift({
        home_id: home._id, service_id: service._id, date: DAYS[0], start_time: '10:00', end_time: '14:00'
      });
      const res = await request(app).post('/api/shifts/assign-preview')
        .set('Authorization', getAuthHeader(worker._id))
        .send({ shift_ids: [over._id, fine._id, clash._id] })
        .expect(200);

      expect(res.body[over._id].outcome).toBe('pending');
      expect(res.body[over._id].reasons.join(' ')).toMatch(/52\.0/);
      expect(res.body[fine._id].outcome).toBe('ok'); // next week
      expect(res.body[clash._id].outcome).toBe('blocked'); // overlaps their 08:00–20:00
      // Preview changes nothing.
      expect(await assignmentOf(over)).toBeUndefined();
    });

    test('admin removal un-assigns them', async () => {
      await assign(over, worker).expect(200);
      await request(app).post(`/api/shifts/${over._id}/hours-cap-exception/${worker._id}/remove`)
        .set('Authorization', getAuthHeader(admin._id)).expect(200);
      expect(await assignmentOf(over)).toBeUndefined();
    });
  });

  test('the cap uses the home break policy', async () => {
    home.break_policy = { enabled: false, tiers: [] };
    await home.save();
    // No break deduction: already 48h, so another 4h goes over.
    const res = await assign(await shortShift(DAYS[4]), keyWorker);
    expect(res.status).toBe(409);
  });
});
