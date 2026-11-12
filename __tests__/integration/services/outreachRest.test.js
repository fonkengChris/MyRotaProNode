process.env.NODE_ENV = 'test';

const SchedulingConflictService = require('../../../services/schedulingConflictService');
const {
  createTestUser,
  createTestHome,
  createTestService,
  createTestShift,
} = require('../../../tests/utils/testHelpers');

const DATE = '2026-01-13';
let seq = 0;
const email = () => `outreach${Date.now()}${seq++}@example.com`;

describe('Minimum rest between outreach shifts', () => {
  let outreachA, outreachB, supportedLiving, worker;

  beforeEach(async () => {
    outreachA = await createTestHome({ name: 'Ashgrove Outreach', service_type: 'community_outreach' });
    outreachB = await createTestHome({ name: 'Elmtree Outreach', service_type: 'community_outreach' });
    supportedLiving = await createTestHome({ name: 'Maple House' });
    worker = await createTestUser({ email: email(), homes: [{ home_id: outreachA._id }] });
  });

  const assignedShift = async (home, start_time, end_time) => {
    const service = await createTestService({ home_id: home._id, category: 'social', duration_hours: 6, max_staff_count: 3 });
    return createTestShift({
      home_id: home._id,
      service_id: service._id,
      date: DATE,
      start_time,
      end_time,
      assigned_staff: [{ user_id: worker._id, status: 'assigned' }],
    });
  };

  const check = (home, start, end) =>
    SchedulingConflictService.checkShiftAssignmentConflict(worker._id, DATE, start, end, { homeId: home._id.toString() });

  test('30 minutes between two outreach shifts is enough', async () => {
    await assignedShift(outreachA, '08:00', '14:00');
    const result = await check(outreachB, '14:30', '21:00');
    expect(result.hasConflict).toBe(false);
  });

  test('less than 30 minutes between outreach shifts is flagged', async () => {
    await assignedShift(outreachA, '08:00', '14:00');
    const result = await check(outreachB, '14:15', '21:00');
    expect(result.conflictType).toBe('insufficient_rest');
    expect(result.message).toMatch(/minimum 0.5h/);
  });

  test('the normal 8h rule applies when either shift is not outreach', async () => {
    await assignedShift(outreachA, '08:00', '14:00');
    const result = await check(supportedLiving, '14:30', '21:00');
    expect(result.conflictType).toBe('insufficient_rest');
    expect(result.message).toMatch(/minimum 8h/);
  });
});
