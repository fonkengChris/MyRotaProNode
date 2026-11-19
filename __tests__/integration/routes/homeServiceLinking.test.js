// Ensure test environment is set before importing server
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only';
process.env.JWT_EXPIRES_IN = '7d';

const request = require('supertest');
const app = require('../../../server');
const Service = require('../../../models/Service');
const { createTestUser, createTestHome, getAuthHeader } = require('../../../tests/utils/testHelpers');

const makeService = (name, homeIds, extra = {}) => Service.create({
  name,
  description: `${name} service`,
  home_ids: homeIds,
  category: 'social',
  required_skills: ['social_support'],
  min_staff_count: 1,
  max_staff_count: 5,
  duration_hours: 8,
  ...extra,
});

const homeBody = (name, service_type) => ({
  name,
  service_type,
  location: { address: '1 New Street', city: 'Derby', postcode: 'DE1 1AA' },
  contact_info: { phone: '+447123456789', email: 'home@example.com' },
  capacity: 5,
});

describe('new homes are linked to their service type\'s services', () => {
  let admin, outreach, supported, retired;

  beforeEach(async () => {
    admin = await createTestUser({ role: 'admin', email: `admin${Date.now()}@example.com` });
    const outreachHome = await createTestHome({ name: 'Outreach A', service_type: 'community_outreach' });
    const slHome = await createTestHome({ name: 'House A', service_type: 'supported_living' });
    outreach = await makeService('Outreach', [outreachHome._id]);
    supported = await makeService('Supported Living', [slHome._id]);
    retired = await makeService('Old Outreach', [outreachHome._id], { is_active: false });
  });

  test('a new outreach home joins the active outreach service only', async () => {
    const res = await request(app)
      .post('/api/homes')
      .set('Authorization', getAuthHeader(admin._id))
      .send(homeBody('Outreach B', 'community_outreach'))
      .expect(201);
    const id = res.body._id || res.body.id;

    const list = await request(app)
      .get(`/api/services?home_id=${id}`)
      .set('Authorization', getAuthHeader(admin._id))
      .expect(200);
    expect(list.body.map((s) => s.name)).toEqual(['Outreach']);

    expect((await Service.findById(supported._id)).home_ids.map(String)).not.toContain(String(id));
    expect((await Service.findById(retired._id)).home_ids.map(String)).not.toContain(String(id));
    expect((await Service.findById(outreach._id)).home_ids).toHaveLength(2);
  });

  test('a home of a type with no existing services is still created', async () => {
    await request(app)
      .post('/api/homes')
      .set('Authorization', getAuthHeader(admin._id))
      .send(homeBody('Day Centre A', 'day_centre'))
      .expect(201);
  });
});
