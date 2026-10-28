// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const Availability = require('../../../models/Availability');
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

  it('stops key workers declaring availability for staff', async () => {
    expect((await declare(keyWorker, parttime)).status).toBe(403);
  });

  it('lets an admin declare, update and delete availability for any staff member', async () => {
    const created = await declare(admin, fulltime);
    expect(created.status).toBe(201);

    const id = created.body._id;
    const updated = await request(app)
      .put(`/api/availability/${id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .send({ is_available: false });
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
      .send({ is_available: false });
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
      .send({ is_available: false });
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
      .send({ user_id: bank._id.toString(), is_available: false });
    expect(res.status).toBe(200);
    expect(String(res.body.user_id)).toBe(parttime._id.toString());
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
