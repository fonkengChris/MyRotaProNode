// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

jest.mock('../../../services/pushService', () => ({ sendPushToUser: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const app = require('../../../server');
const Message = require('../../../models/Message');
const Rota = require('../../../models/Rota');
const ShiftSwap = require('../../../models/ShiftSwap');
const { sendPushToUser } = require('../../../services/pushService');
const { flushShiftChangeNotifications } = require('../../../services/shiftChangeNotifications');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
  getAuthHeader,
} = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;
const DAY = '2030-03-04'; // a Monday
const NEXT_DAY = '2030-03-05';

describe('shift change notifications', () => {
  let admin, worker, colleague, home, service;

  const makeShift = (overrides = {}) =>
    createTestShift({
      home_id: home._id,
      service_id: service._id,
      date: DAY,
      start_time: '08:00',
      end_time: '20:00',
      required_staff_count: 2,
      ...overrides,
    });

  const messagesTo = async (user) => {
    await flushShiftChangeNotifications();
    return Message.find({ to_user_id: user._id });
  };

  beforeEach(async () => {
    await flushShiftChangeNotifications();
    sendPushToUser.mockClear();
    home = await createTestHome({ name: 'Oak House' });
    service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 8, max_staff_count: 5 });
    admin = await createTestUser({ email: email('admin'), role: 'admin' });
    worker = await createTestUser({ email: email('worker'), role: 'support_worker', homes: [{ home_id: home._id }] });
    colleague = await createTestUser({ email: email('colleague'), role: 'support_worker', homes: [{ home_id: home._id }] });
  });

  test('assigning someone sends them a message from the actor and a push', async () => {
    const shift = await makeShift();

    await request(app)
      .post(`/api/shifts/${shift._id}/assign`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ user_id: worker._id })
      .expect(200);

    const [message, ...rest] = await messagesTo(worker);
    expect(rest).toHaveLength(0);
    expect(String(message.from_user_id)).toBe(String(admin._id));
    expect(message.body).toContain('Assigned: Mon 4 Mar, 08:00–20:00 (day) at Oak House');
    expect(sendPushToUser).toHaveBeenCalledWith(
      String(worker._id),
      expect.objectContaining({ title: 'Your rota has changed', url: '/my-schedule' })
    );
  });

  test('selecting your own shift sends you nothing', async () => {
    const shift = await makeShift();

    await request(app)
      .post(`/api/shifts/${shift._id}/assign`)
      .set('Authorization', getAuthHeader(worker._id))
      .send({ user_id: worker._id })
      .expect(200);

    expect(await messagesTo(worker)).toHaveLength(0);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  test('removing someone tells them', async () => {
    const shift = await makeShift({ assigned_staff: [{ user_id: worker._id }] });

    await request(app)
      .delete(`/api/shifts/${shift._id}/assign/${worker._id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);

    const [message] = await messagesTo(worker);
    expect(message.body).toContain('Removed: Mon 4 Mar');
  });

  test('moving a shift tells everyone on it, with the old time', async () => {
    const shift = await makeShift({ assigned_staff: [{ user_id: worker._id }, { user_id: colleague._id }] });

    await request(app)
      .put(`/api/shifts/${shift._id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ start_time: '09:00' })
      .expect(200);

    for (const user of [worker, colleague]) {
      const [message] = await messagesTo(user);
      expect(message.body).toContain('Changed: Mon 4 Mar, 09:00–20:00');
      expect(message.body).toContain('(was Mon 4 Mar, 08:00–20:00');
    }
  });

  test('editing notes or staffing numbers notifies nobody', async () => {
    const shift = await makeShift({ assigned_staff: [{ user_id: worker._id }] });

    await request(app)
      .put(`/api/shifts/${shift._id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ notes: 'Bring keys', required_staff_count: 3 })
      .expect(200);

    expect(await messagesTo(worker)).toHaveLength(0);
  });

  test('deactivating and deleting a shift tell its staff it is cancelled', async () => {
    const deactivated = await makeShift({ assigned_staff: [{ user_id: worker._id }] });
    const deleted = await makeShift({ date: NEXT_DAY, assigned_staff: [{ user_id: colleague._id }] });

    await request(app)
      .put(`/api/shifts/${deactivated._id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ is_active: false })
      .expect(200);
    await request(app).delete(`/api/shifts/${deleted._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);

    expect((await messagesTo(worker))[0].body).toContain('Cancelled: Mon 4 Mar');
    expect((await messagesTo(colleague))[0].body).toContain('Cancelled: Tue 5 Mar');
  });

  test('changes to shifts already over are not announced', async () => {
    const shift = await makeShift({ date: '2020-03-02', assigned_staff: [{ user_id: worker._id }] });

    await request(app).delete(`/api/shifts/${shift._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);

    expect(await messagesTo(worker)).toHaveLength(0);
  });

  test('inactive staff are skipped', async () => {
    worker.is_active = false;
    await worker.save();
    const shift = await makeShift({ assigned_staff: [{ user_id: worker._id }] });

    await request(app).delete(`/api/shifts/${shift._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);

    expect(await messagesTo(worker)).toHaveLength(0);
  });

  test('several quick changes reach each person as one summary, in date order', async () => {
    const later = await makeShift({ date: NEXT_DAY, assigned_staff: [{ user_id: worker._id }] });
    const earlier = await makeShift({ assigned_staff: [{ user_id: worker._id }] });

    await request(app).delete(`/api/shifts/${later._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);
    await request(app).delete(`/api/shifts/${earlier._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);

    const messages = await messagesTo(worker);
    expect(messages).toHaveLength(1);
    const [, first, second] = messages[0].body.split('\n');
    expect(first).toContain('Mon 4 Mar');
    expect(second).toContain('Tue 5 Mar');
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendPushToUser.mock.calls[0][1].body).toBe('2 of your shifts have changed. Open My Schedule to see them.');
  });

  test('approving a held shift and declining one both tell the staff member', async () => {
    const approved = await makeShift({
      assigned_staff: [{ user_id: worker._id, hours_cap_exception_status: 'pending' }],
    });
    const declined = await makeShift({
      date: NEXT_DAY,
      assigned_staff: [{ user_id: colleague._id, hours_cap_exception_status: 'pending' }],
    });

    await request(app)
      .post(`/api/shifts/${approved._id}/hours-cap-exception/${worker._id}/confirm`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);
    await request(app)
      .post(`/api/shifts/${declined._id}/hours-cap-exception/${colleague._id}/remove`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);

    expect((await messagesTo(worker))[0].body).toContain('Approved: Mon 4 Mar');
    expect((await messagesTo(colleague))[0].body).toContain('Removed: Tue 5 Mar');
  });

  test('a completed swap tells the requester both sides; the person accepting is not messaged', async () => {
    const requesterShift = await makeShift({ required_staff_count: 1, assigned_staff: [{ user_id: worker._id }] });
    const targetShift = await makeShift({ date: NEXT_DAY, required_staff_count: 1, assigned_staff: [{ user_id: colleague._id }] });
    const swap = await ShiftSwap.create({
      home_id: home._id,
      requester_id: worker._id,
      target_user_id: colleague._id,
      requester_shift_id: requesterShift._id,
      target_shift_id: targetShift._id,
      request_message: 'Please swap',
    });

    await request(app)
      .post(`/api/shift-swaps/${swap._id}/approve`)
      .set('Authorization', getAuthHeader(colleague._id))
      .send({})
      .expect(200);

    const [message, ...rest] = await messagesTo(worker);
    expect(rest).toHaveLength(0);
    expect(message.body).toContain('Removed: Mon 4 Mar');
    expect(message.body).toContain('Assigned: Tue 5 Mar');
    expect(await messagesTo(colleague)).toHaveLength(0);
  });

  test('deleting a rota tells staff their shifts were removed', async () => {
    const shift = await makeShift({ assigned_staff: [{ user_id: worker._id }] });
    const rota = await Rota.create({
      home_id: home._id,
      service_id: service._id,
      week_start_date: new Date('2030-03-04'),
      week_end_date: new Date('2030-03-10'),
      shifts: [shift._id],
      created_by: admin._id,
    });

    await request(app).delete(`/api/rotas/${rota._id}`).set('Authorization', getAuthHeader(admin._id)).expect(200);

    expect((await messagesTo(worker))[0].body).toContain('Removed: Mon 4 Mar');
  });
});
