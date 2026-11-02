process.env.NODE_ENV = 'test';

const AISolver = require('../../../services/aiSolver');
const SolverSettings = require('../../../models/SolverSettings');
const Shift = require('../../../models/Shift');
const Message = require('../../../models/Message');
const { flushShiftChangeNotifications } = require('../../../services/shiftChangeNotifications');
const { restHoursBetween, capHoursAfterBreak } = require('../../../utils/shiftHours');
const { createTestUser, createTestHome, createTestService, createTestShift } = require('../../../tests/utils/testHelpers');

let seq = 0;
const email = (prefix) => `${prefix}${Date.now()}${seq++}@example.com`;

const WEEK = ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08', '2030-03-09', '2030-03-10'];

async function seedWeek() {
  const home = await createTestHome();
  const service = await createTestService({ home_id: home._id, category: 'personal_care', duration_hours: 12, max_staff_count: 5 });
  const staff = [];
  for (let i = 0; i < 3; i++) {
    staff.push(await createTestUser({
      email: email(`sw${i}`),
      role: 'support_worker',
      type: 'fulltime',
      homes: [{ home_id: home._id, is_default: true }]
    }));
  }
  // Not auto-assignable by default.
  await createTestUser({ email: email('senior'), role: 'senior_staff', homes: [{ home_id: home._id, is_default: true }] });

  for (const date of WEEK) {
    await createTestShift({ home_id: home._id, service_id: service._id, date, start_time: '08:00', end_time: '20:00', shift_type: 'day' });
    await createTestShift({ home_id: home._id, service_id: service._id, date, start_time: '20:00', end_time: '08:00', shift_type: 'night' });
  }
  return { home, service, staff };
}

async function assignedShiftsByUser(homeId) {
  const shifts = await Shift.find({ home_id: homeId }).lean();
  const byUser = {};
  for (const s of shifts) {
    for (const a of s.assigned_staff) {
      (byUser[a.user_id.toString()] = byUser[a.user_id.toString()] || []).push(s);
    }
  }
  return byUser;
}

function minRestFor(shifts) {
  let min = Infinity;
  for (let i = 0; i < shifts.length; i++) {
    for (let j = i + 1; j < shifts.length; j++) {
      min = Math.min(min, restHoursBetween(shifts[i], shifts[j]));
    }
  }
  return min;
}

function longestRun(shifts) {
  const days = [...new Set(shifts.map((s) => s.date))].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    const next = prev && new Date(Date.parse(`${prev}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    run = next === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

async function assignmentCounts(homeId) {
  const byUser = await assignedShiftsByUser(homeId);
  return Object.fromEntries(Object.entries(byUser).map(([id, shifts]) => [id, shifts.length]));
}

describe('AISolver end to end', () => {
  test('default rules: only support workers, no overlaps, at least 8h rest', async () => {
    const { home, service, staff } = await seedWeek();
    const result = await new AISolver().generateRota(
      new Date(WEEK[0]), new Date(WEEK[6]), [home._id.toString()], service._id.toString(), []
    );
    expect(result.success).toBe(true);

    const byUser = await assignedShiftsByUser(home._id);
    const staffIds = new Set(staff.map((s) => s._id.toString()));
    expect(Object.keys(byUser).length).toBeGreaterThan(0);
    for (const [userId, shifts] of Object.entries(byUser)) {
      expect(staffIds.has(userId)).toBe(true);
      expect(minRestFor(shifts)).toBeGreaterThanOrEqual(8);
      const weekHours = shifts.reduce((sum, s) => sum + capHoursAfterBreak(s, home.break_policy), 0);
      expect(weekHours).toBeLessThanOrEqual(48);
    }
  });

  test('tells each newly assigned person once', async () => {
    const { home, service } = await seedWeek();
    const admin = await createTestUser({ email: `solver-admin${Date.now()}@example.com`, role: 'admin' });
    const generate = () => new AISolver().generateRota(
      new Date(WEEK[0]), new Date(WEEK[6]), [home._id.toString()], service._id.toString(), [],
      { notifyActorId: admin._id }
    );

    expect((await generate()).success).toBe(true);
    await flushShiftChangeNotifications();

    const assignedIds = Object.keys(await assignedShiftsByUser(home._id));
    expect(assignedIds.length).toBeGreaterThan(0);
    const messages = await Message.find({ from_user_id: admin._id });
    expect(messages.map((m) => String(m.to_user_id)).sort()).toEqual([...assignedIds].sort());

    // Re-running only announces assignments it actually adds.
    const countsBefore = await assignmentCounts(home._id);
    await Message.deleteMany({});
    await generate();
    await flushShiftChangeNotifications();
    const countsAfter = await assignmentCounts(home._id);
    const gained = Object.keys(countsAfter).filter((id) => countsAfter[id] > (countsBefore[id] || 0));
    const rerunMessages = await Message.find({ from_user_id: admin._id });
    expect(rerunMessages.map((m) => String(m.to_user_id)).sort()).toEqual(gained.sort());
  });

  test('admin-edited rules change the generated rota', async () => {
    const settings = await SolverSettings.getSettings();
    settings.min_rest_hours = 12;
    settings.consecutive_days_enabled = true;
    settings.max_consecutive_days = 2;
    await settings.save();

    const { home, service } = await seedWeek();
    const result = await new AISolver().generateRota(
      new Date(WEEK[0]), new Date(WEEK[6]), [home._id.toString()], service._id.toString(), []
    );
    expect(result.success).toBe(true);

    const byUser = await assignedShiftsByUser(home._id);
    expect(Object.keys(byUser).length).toBeGreaterThan(0);
    for (const shifts of Object.values(byUser)) {
      expect(minRestFor(shifts)).toBeGreaterThanOrEqual(12);
      expect(longestRun(shifts)).toBeLessThanOrEqual(2);
    }
  });
});
