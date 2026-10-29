process.env.NODE_ENV = 'test';

const Shift = require('../../../models/Shift');
const Timetable = require('../../../models/Timetable');
const { buildTimetableSnapshot, applySnapshot } = require('../../../services/timetableSync');
const { createTestUser, createTestHome, createTestService, createTestShift } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for timetable sync');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function seedGeneratedTimetable(status = 'generated') {
  const home = await createTestHome();
  const service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 12, max_staff_count: 5 });
  const admin = await createTestUser({ email: email('admin'), role: 'admin' });
  const worker = await createTestUser({
    email: email('sw'),
    role: 'support_worker',
    type: 'fulltime',
    homes: [{ home_id: home._id, is_default: true }]
  });
  const shift = await createTestShift({
    home_id: home._id, service_id: service._id, date: '2030-03-05',
    start_time: '08:00', end_time: '20:00', shift_type: 'day'
  });

  const timetable = new Timetable({
    name: 'Auto-sync test',
    home_ids: [home._id],
    start_date: new Date('2030-03-04'),
    end_date: new Date('2030-03-10'),
    total_weeks: 1,
    generated_by: admin._id,
    total_shifts: 0, total_hours: 0, total_assignments: 0, average_weekly_hours: 0
  });
  applySnapshot(timetable, await buildTimetableSnapshot(timetable));
  timetable.status = status;
  timetable.generation_completed_at = new Date();
  await timetable.save();

  return { home, service, worker, shift, timetable };
}

const snapshotShifts = async (id) => (await Timetable.findById(id)).weekly_rotas[0].shifts;

describe('timetable auto-sync on shift changes', () => {
  it('reflects a new staff assignment', async () => {
    const { worker, shift, timetable } = await seedGeneratedTimetable();
    expect((await snapshotShifts(timetable._id))[0].assigned_staff).toHaveLength(0);

    shift.assignStaff(worker._id);
    await shift.save();

    const shifts = await waitFor(async () => {
      const s = await snapshotShifts(timetable._id);
      return s[0].assigned_staff.length === 1 && s;
    });
    expect(shifts[0].assigned_staff[0].user_id.toString()).toBe(worker._id.toString());
  });

  it('reflects shift time edits, additions and deletions', async () => {
    const { home, service, shift, timetable } = await seedGeneratedTimetable('published');

    await Shift.findByIdAndUpdate(shift._id, { end_time: '18:00' });
    await waitFor(async () => (await snapshotShifts(timetable._id))[0].end_time === '18:00');

    await createTestShift({
      home_id: home._id, service_id: service._id, date: '2030-03-06',
      start_time: '20:00', end_time: '08:00', shift_type: 'night'
    });
    await waitFor(async () => (await Timetable.findById(timetable._id)).total_shifts === 2);

    await Shift.findByIdAndDelete(shift._id);
    const after = await waitFor(async () => {
      const t = await Timetable.findById(timetable._id);
      return t.total_shifts === 1 && t;
    });
    expect(after.status).toBe('published');
    expect(after.weekly_rotas[0].shifts[0].date).toBe('2030-03-06');
  });

  it('ignores shifts outside the timetable range', async () => {
    const { home, service, timetable } = await seedGeneratedTimetable();
    const before = (await Timetable.findById(timetable._id)).updated_at;

    await createTestShift({
      home_id: home._id, service_id: service._id, date: '2030-04-01',
      start_time: '08:00', end_time: '20:00', shift_type: 'day'
    });
    await new Promise(r => setTimeout(r, 2500));

    const t = await Timetable.findById(timetable._id);
    expect(t.total_shifts).toBe(1);
    expect(t.updated_at.getTime()).toBe(before.getTime());
  });

  it('leaves archived timetables untouched', async () => {
    const { worker, shift, timetable } = await seedGeneratedTimetable('archived');

    shift.assignStaff(worker._id);
    await shift.save();
    await new Promise(r => setTimeout(r, 2500));

    expect((await snapshotShifts(timetable._id))[0].assigned_staff).toHaveLength(0);
  });
});
