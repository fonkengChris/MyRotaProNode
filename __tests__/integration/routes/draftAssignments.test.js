// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

jest.mock('../../../services/pushService', () => ({ sendPushToUser: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const app = require('../../../server');
const AISolver = require('../../../services/aiSolver');
const Shift = require('../../../models/Shift');
const Message = require('../../../models/Message');
const Timetable = require('../../../models/Timetable');
const TimeOffRequest = require('../../../models/TimeOffRequest');
const { flushShiftChangeNotifications } = require('../../../services/shiftChangeNotifications');
const { buildTimetableSnapshot, applySnapshot } = require('../../../services/timetableSync');
const { findTimetableConflictForLeave } = require('../../../services/timeOffService');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;
const WEEK = ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08', '2030-03-09', '2030-03-10'];
const MONDAY = WEEK[0];

describe('draft assignments', () => {
  let admin, worker, colleague, home, service;

  const makeShift = (overrides = {}) =>
    createTestShift({
      home_id: home._id,
      service_id: service._id,
      date: MONDAY,
      start_time: '08:00',
      end_time: '20:00',
      shift_type: 'day',
      required_staff_count: 2,
      ...overrides,
    });

  const draft = (userId, timetableId = null) => ({ user_id: userId, is_draft: true, draft_timetable_id: timetableId });

  const messagesTo = async (user) => {
    await flushShiftChangeNotifications();
    return Message.find({ to_user_id: user._id });
  };

  const makeGeneratedTimetable = async () => {
    const timetable = new Timetable({
      name: 'March draft',
      home_ids: [home._id],
      start_date: new Date(WEEK[0]),
      end_date: new Date(WEEK[6]),
      total_weeks: 1,
      generated_by: admin._id,
      total_shifts: 0, total_hours: 0, total_assignments: 0, average_weekly_hours: 0,
    });
    applySnapshot(timetable, await buildTimetableSnapshot(timetable));
    timetable.status = 'generated';
    timetable.generation_completed_at = new Date();
    await timetable.save();
    return timetable;
  };

  beforeEach(async () => {
    await flushShiftChangeNotifications();
    home = await createTestHome({ name: 'Oak House' });
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 12, max_staff_count: 5 });
    admin = await createTestUser({ email: email('admin'), role: 'admin' });
    worker = await createTestUser({ email: email('worker'), role: 'support_worker', type: 'fulltime', homes: [{ home_id: home._id, is_default: true }] });
    colleague = await createTestUser({ email: email('colleague'), role: 'support_worker', type: 'fulltime', homes: [{ home_id: home._id, is_default: true }] });
  });

  test('drafted generation saves draft assignments and tells nobody', async () => {
    for (const date of WEEK) await makeShift({ date, required_staff_count: 1 });

    const result = await new AISolver().generateRota(
      new Date(WEEK[0]), new Date(WEEK[6]), [home._id.toString()], service._id.toString(), [],
      { notifyActorId: admin._id, draft: {} }
    );
    expect(result.success).toBe(true);

    const assignments = (await Shift.find({ home_id: home._id }).lean()).flatMap((s) => s.assigned_staff);
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((a) => a.is_draft === true)).toBe(true);
    await flushShiftChangeNotifications();
    expect(await Message.countDocuments({ from_user_id: admin._id })).toBe(0);
  });

  test('staff never see drafts; rota editors see them only when asked', async () => {
    await makeShift({ assigned_staff: [draft(worker._id), { user_id: colleague._id }] });
    const query = `/api/shifts?start_date=${WEEK[0]}&end_date=${WEEK[6]}`;

    const own = await request(app).get(`${query}&user_id=${worker._id}`).set('Authorization', getAuthHeader(worker._id)).expect(200);
    expect(own.body).toHaveLength(0);

    const asked = await request(app).get(`${query}&include_drafts=true`).set('Authorization', getAuthHeader(worker._id)).expect(200);
    expect(asked.body[0].assigned_staff.map((a) => String(a.user_id))).toEqual([String(colleague._id)]);

    const adminDefault = await request(app).get(query).set('Authorization', getAuthHeader(admin._id)).expect(200);
    expect(adminDefault.body[0].assigned_staff).toHaveLength(1);

    const editor = await request(app).get(`${query}&include_drafts=true`).set('Authorization', getAuthHeader(admin._id)).expect(200);
    expect(editor.body[0].assigned_staff).toHaveLength(2);
  });

  test('a rota edit in a draft week joins the draft and tells nobody', async () => {
    await makeShift({ date: WEEK[2], assigned_staff: [draft(colleague._id)] });
    const shift = await makeShift();

    await request(app)
      .post(`/api/shifts/${shift._id}/assign`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ user_id: worker._id })
      .expect(200);

    const saved = await Shift.findById(shift._id);
    expect(saved.assigned_staff[0].is_draft).toBe(true);
    expect(await messagesTo(worker)).toHaveLength(0);
  });

  test('removing a draft assignment tells nobody', async () => {
    const shift = await makeShift({ assigned_staff: [draft(worker._id)] });

    await request(app)
      .delete(`/api/shifts/${shift._id}/assign/${worker._id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);

    expect(await messagesTo(worker)).toHaveLength(0);
  });

  test('publishing a week makes drafts live and tells each person once', async () => {
    await makeShift({ assigned_staff: [draft(worker._id), draft(colleague._id)] });
    await makeShift({ date: WEEK[1], assigned_staff: [draft(worker._id)] });

    await request(app)
      .post('/api/shifts/publish-drafts')
      .set('Authorization', getAuthHeader(worker._id))
      .send({ home_id: String(home._id), week_start: MONDAY })
      .expect(403);

    const res = await request(app)
      .post('/api/shifts/publish-drafts')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ home_id: String(home._id), week_start: MONDAY })
      .expect(200);
    expect(res.body.assignments_published).toBe(3);

    const assignments = (await Shift.find({ home_id: home._id }).lean()).flatMap((s) => s.assigned_staff);
    expect(assignments.some((a) => a.is_draft)).toBe(false);
    const [message, ...rest] = await messagesTo(worker);
    expect(rest).toHaveLength(0);
    expect(message.body).toContain('Assigned: Mon 4 Mar');
    expect(message.body).toContain('Assigned: Tue 5 Mar');
  });

  test("week publishing leaves a timetable's drafts for the timetable", async () => {
    const timetable = await makeGeneratedTimetable();
    await makeShift({ assigned_staff: [draft(worker._id, timetable._id)] });

    const res = await request(app)
      .post('/api/shifts/publish-drafts')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ home_id: String(home._id), week_start: MONDAY })
      .expect(409);
    expect(res.body.timetable.name).toBe('March draft');
  });

  test('publishing a timetable allocates its drafts and notifies staff', async () => {
    const timetable = await makeGeneratedTimetable();
    await makeShift({ assigned_staff: [draft(worker._id, timetable._id)] });

    const res = await request(app)
      .post(`/api/timetables/${timetable._id}/publish`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);
    expect(res.body.status).toBe('published');
    expect(res.body.assignments_published).toBe(1);

    const [shift] = await Shift.find({ home_id: home._id }).lean();
    expect(shift.assigned_staff[0].is_draft).toBe(false);
    expect(await messagesTo(worker)).toHaveLength(1);
  });

  test('approved leave clashing with a draft blocks publishing, but drafts never block leave', async () => {
    const timetable = await makeGeneratedTimetable();
    await makeShift({ assigned_staff: [draft(worker._id, timetable._id)] });

    expect(await findTimetableConflictForLeave(worker._id, MONDAY, MONDAY)).toBeNull();

    await TimeOffRequest.create({
      user_id: worker._id,
      start_date: MONDAY,
      end_date: MONDAY,
      request_type: 'annual_leave',
      reason: 'Holiday',
      status: 'approved',
    });

    await request(app)
      .post(`/api/timetables/${timetable._id}/publish`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(400);
    const [shift] = await Shift.find({ home_id: home._id }).lean();
    expect(shift.assigned_staff[0].is_draft).toBe(true);
    expect(await messagesTo(worker)).toHaveLength(0);
  });

  test('discarding a week removes only its drafts and tells nobody', async () => {
    const shift = await makeShift({ assigned_staff: [draft(worker._id), { user_id: colleague._id }] });
    const nextWeek = await makeShift({ date: '2030-03-11', assigned_staff: [draft(worker._id)] });

    await request(app)
      .post('/api/shifts/discard-drafts')
      .set('Authorization', getAuthHeader(worker._id))
      .send({ home_id: String(home._id), week_start: MONDAY })
      .expect(403);

    const res = await request(app)
      .post('/api/shifts/discard-drafts')
      .set('Authorization', getAuthHeader(admin._id))
      .send({ home_id: String(home._id), week_start: MONDAY })
      .expect(200);
    expect(res.body.assignments_discarded).toBe(1);

    const kept = await Shift.findById(shift._id).lean();
    expect(kept.assigned_staff.map((a) => String(a.user_id))).toEqual([String(colleague._id)]);
    expect((await Shift.findById(nextWeek._id).lean()).assigned_staff).toHaveLength(1);
    expect(await messagesTo(worker)).toHaveLength(0);
    expect(await messagesTo(colleague)).toHaveLength(0);
  });

  test("discarding a timetable's draft removes its drafts and resets it for regeneration", async () => {
    const timetable = await makeGeneratedTimetable();
    const shift = await makeShift({
      assigned_staff: [draft(worker._id, timetable._id), draft(colleague._id), { user_id: admin._id }],
    });

    const res = await request(app)
      .post(`/api/timetables/${timetable._id}/discard-draft`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);
    expect(res.body.assignments_discarded).toBe(1);
    expect(res.body.status).toBe('draft');
    expect(res.body.generation_completed_at).toBeNull();

    // Only the timetable's draft goes; Rota Editor drafts and live work stay.
    const kept = await Shift.findById(shift._id).lean();
    expect(kept.assigned_staff.map((a) => String(a.user_id)).sort()).toEqual([String(colleague._id), String(admin._id)].sort());
    expect(await messagesTo(worker)).toHaveLength(0);

    await request(app)
      .post(`/api/timetables/${timetable._id}/discard-draft`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(400);
  });

  test('a draft assignment cannot be clocked in to', async () => {
    const shift = await makeShift({ assigned_staff: [draft(worker._id)] });

    await request(app)
      .post(`/api/shifts/${shift._id}/clock-in`)
      .set('Authorization', getAuthHeader(worker._id))
      .send({})
      .expect(403);
  });
});
