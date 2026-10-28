// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const Message = require('../../../models/Message');
const ServiceUser = require('../../../models/ServiceUser');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

describe('messages: bulk send, edit and delete', () => {
  let alice, bob, carol;

  beforeEach(async () => {
    alice = await createTestUser({ name: 'Alice', role: 'admin', email: email('alice') });
    bob = await createTestUser({ name: 'Bob', email: email('bob') });
    carol = await createTestUser({ name: 'Carol', email: email('carol') });
  });

  const send = async (from, to, body) =>
    (await request(app).post('/api/messages').set('Authorization', getAuthHeader(from._id)).send({ to_user_id: String(to._id), body })).body;

  test('bulk send delivers one direct message per unique recipient', async () => {
    const res = await request(app)
      .post('/api/messages/bulk')
      .set('Authorization', getAuthHeader(alice._id))
      .send({ to_user_ids: [String(bob._id), String(carol._id), String(bob._id)], body: 'Team update' });

    expect(res.status).toBe(201);
    expect(res.body.sent).toBe(2);
    expect(await Message.countDocuments({ from_user_id: alice._id, body: 'Team update' })).toBe(2);
  });

  test('bulk send rejects the whole batch if any recipient is invalid', async () => {
    const res = await request(app)
      .post('/api/messages/bulk')
      .set('Authorization', getAuthHeader(alice._id))
      .send({ to_user_ids: [String(bob._id), String(alice._id)], body: 'Hi' });

    expect(res.status).toBe(403);
    expect(await Message.countDocuments({})).toBe(0);
  });

  test('sender can edit their message, keeping line breaks, and it is marked edited', async () => {
    const msg = await send(alice, bob, 'Hello');
    const res = await request(app)
      .patch(`/api/messages/${msg.id}`)
      .set('Authorization', getAuthHeader(alice._id))
      .send({ body: 'Hello\n\n  indented line' });

    expect(res.status).toBe(200);
    expect(res.body.body).toBe('Hello\n\n  indented line');
    expect(res.body.edited_at).toBeTruthy();
  });

  test('recipient cannot edit or delete a message they did not send', async () => {
    const msg = await send(alice, bob, 'Hello');

    const edit = await request(app).patch(`/api/messages/${msg.id}`).set('Authorization', getAuthHeader(bob._id)).send({ body: 'Hacked' });
    const del = await request(app).delete(`/api/messages/${msg.id}`).set('Authorization', getAuthHeader(bob._id));

    expect(edit.status).toBe(403);
    expect(del.status).toBe(403);
    expect((await Message.findById(msg.id)).body).toBe('Hello');
  });

  test('deleted messages show as deleted to both people and cannot be edited', async () => {
    const msg = await send(alice, bob, 'Secret plan');
    const del = await request(app).delete(`/api/messages/${msg.id}`).set('Authorization', getAuthHeader(alice._id));
    expect(del.status).toBe(200);
    expect(del.body.deleted_at).toBeTruthy();
    expect(del.body.body).toBe('');

    const thread = await request(app).get(`/api/messages/thread/${alice._id}`).set('Authorization', getAuthHeader(bob._id));
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.messages[0].body).toBe('');
    expect(thread.body.messages[0].deleted_at).toBeTruthy();

    const convs = await request(app).get('/api/messages/conversations').set('Authorization', getAuthHeader(bob._id));
    expect(convs.body[0].last_deleted).toBe(true);
    expect(convs.body[0].last_body).toBe('');

    const edit = await request(app).patch(`/api/messages/${msg.id}`).set('Authorization', getAuthHeader(alice._id)).send({ body: 'Again' });
    expect(edit.status).toBe(410);
  });

  test('deleted unread messages do not count as unread', async () => {
    const msg = await send(alice, bob, 'Oops');
    await request(app).delete(`/api/messages/${msg.id}`).set('Authorization', getAuthHeader(alice._id));

    const convs = await request(app).get('/api/messages/conversations').set('Authorization', getAuthHeader(bob._id));
    expect(convs.body[0].unread_count).toBe(0);
  });
});

describe('messages: who support workers can reach', () => {
  let admin, worker, houseMate, otherHouse, keyWorker, otherKeyWorker;

  beforeEach(async () => {
    const homeA = await createTestHome({ name: 'Home A' });
    const homeB = await createTestHome({ name: 'Home B' });
    admin = await createTestUser({ name: 'Admin', role: 'admin', email: email('admin'), homes: [] });
    worker = await createTestUser({ name: 'Worker', role: 'support_worker', email: email('w'), homes: [{ home_id: homeA._id }] });
    houseMate = await createTestUser({ name: 'Mate', role: 'support_worker', email: email('m'), homes: [{ home_id: homeA._id }] });
    otherHouse = await createTestUser({ name: 'Other', role: 'support_worker', email: email('o'), homes: [{ home_id: homeB._id }] });
    // Key workers aren't attached to houses; they reach them through service users.
    keyWorker = await createTestUser({ name: 'KW', role: 'key_worker', email: email('kw'), homes: [] });
    otherKeyWorker = await createTestUser({ name: 'KW2', role: 'key_worker', email: email('kw2'), homes: [] });
    await ServiceUser.create({ name: 'Alex', home_id: homeA._id, key_worker_ids: [keyWorker._id] });
    await ServiceUser.create({ name: 'Blake', home_id: homeB._id, key_worker_ids: [otherKeyWorker._id] });
  });

  const recipientIds = async (as) =>
    (await request(app).get('/api/messages/recipients').set('Authorization', getAuthHeader(as._id)).expect(200))
      .body.map((u) => u.id).sort();
  const sendStatus = async (from, to) =>
    (await request(app).post('/api/messages').set('Authorization', getAuthHeader(from._id)).send({ to_user_id: String(to._id), body: 'Hi' })).status;

  test('support workers see house colleagues, their service users\' key workers and management', async () => {
    expect(await recipientIds(worker)).toEqual([admin, houseMate, keyWorker].map((u) => String(u._id)).sort());
  });

  test('key workers can reach staff in their service users\' homes', async () => {
    expect(await recipientIds(keyWorker)).toEqual([admin, worker, houseMate].map((u) => String(u._id)).sort());
  });

  test('sending outside that scope is refused', async () => {
    expect(await sendStatus(worker, keyWorker)).toBe(201);
    expect(await sendStatus(worker, admin)).toBe(201);
    expect(await sendStatus(worker, otherHouse)).toBe(403);
    expect(await sendStatus(worker, otherKeyWorker)).toBe(403);
  });
});
