/**
 * seedFullOrganization.js
 *
 * Seeds a complete, realistic MyRotaPro organisation:
 *   - 8 homes: 5 supported living (24h), 2 community outreach, 1 day centre
 *   - 1 service per home (drives skills/staffing for the rota generator)
 *   - A WeeklySchedule ("shift pattern template") per home — each home gets a
 *     DIFFERENT pattern (mix of waking-night and sleep-in-night cover). This is
 *     the template the rota/timetable generator reads to build shifts.
 *   - 35 staff (18 fulltime, 12 parttime, 5 bank) + 1 admin, allocated to homes
 *     weighted by each home's coverage load.
 *
 * All users share the password: Password123#
 *
 * Usage:
 *   node scripts/seedFullOrganization.js
 *   npm run seed-org
 *
 * NOTE: This is a WIPE & RESEED. It clears Users, Homes, Services,
 * WeeklySchedules and dependent scheduling data (Shifts, Timetables,
 * Availability, Rotas) before seeding.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');
const WeeklySchedule = require('../models/WeeklySchedule');

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';

const COMMON_PASSWORD = 'Password123#';
const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

// ---------------------------------------------------------------------------
// Home + service + shift-pattern definitions (each home has its own pattern)
// ---------------------------------------------------------------------------

const HOME_DEFS = [
  // ---- Supported living (24h) ---------------------------------------------
  {
    key: 'willow',
    name: 'Willow House',
    type: 'supported_living',
    address: '12 Willow Lane',
    city: 'Manchester',
    postcode: 'M14 5TR',
    phone: '+441610000001',
    email: 'willow@myrotapro.com',
    capacity: 6,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      name: 'Willow House Personal Care & Support',
      description: '24-hour personal care and support for residents at Willow House.',
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    // Pattern: long day + sleep-in night (every day)
    pattern: {
      all: [
        { start: '08:00', end: '20:00', shift_type: 'long_day', count: 2, notes: 'Long day' },
        { start: '20:00', end: '08:00', shift_type: 'night-sleep', count: 1, notes: 'Sleep-in night' },
      ],
    },
  },
  {
    key: 'oakwood',
    name: 'Oakwood House',
    type: 'supported_living',
    address: '48 Oakwood Road',
    city: 'Leeds',
    postcode: 'LS6 2QD',
    phone: '+441130000002',
    email: 'oakwood@myrotapro.com',
    capacity: 5,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      name: 'Oakwood House Personal Care & Support',
      description: '24-hour personal care with waking night cover at Oakwood House.',
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    // Pattern: day + waking night (every day)
    pattern: {
      all: [
        { start: '08:00', end: '20:00', shift_type: 'day', count: 2, notes: 'Day' },
        { start: '20:00', end: '08:00', shift_type: 'night-wake', count: 1, notes: 'Waking night' },
      ],
    },
  },
  {
    key: 'maple',
    name: 'Maple Lodge',
    type: 'supported_living',
    address: '3 Maple Crescent',
    city: 'Birmingham',
    postcode: 'B29 6BD',
    phone: '+441210000003',
    email: 'maple@myrotapro.com',
    capacity: 7,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      name: 'Maple Lodge Personal Care & Support',
      description: 'Three-shift personal care model with sleep-in night at Maple Lodge.',
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 8,
      is_24_hour: true,
      priority_level: 'high',
    },
    // Pattern: morning / afternoon / sleep-in night (every day)
    pattern: {
      all: [
        { start: '07:00', end: '15:00', shift_type: 'morning', count: 2, notes: 'Morning' },
        { start: '15:00', end: '23:00', shift_type: 'afternoon', count: 2, notes: 'Afternoon' },
        { start: '23:00', end: '07:00', shift_type: 'night-sleep', count: 1, notes: 'Sleep-in night' },
      ],
    },
  },
  {
    key: 'birchwood',
    name: 'Birchwood House',
    type: 'supported_living',
    address: '77 Birchwood Avenue',
    city: 'Liverpool',
    postcode: 'L18 8AB',
    phone: '+441510000004',
    email: 'birchwood@myrotapro.com',
    capacity: 8,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      name: 'Birchwood House Complex Care & Support',
      description: 'High-dependency 24-hour care with double waking night cover at Birchwood House.',
      category: 'specialist',
      required_skills: ['personal_care', 'medication', 'specialist_care'],
      min_staff_count: 2,
      max_staff_count: 4,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'critical',
    },
    // Pattern: long day + double waking night (every day) — highest load
    pattern: {
      all: [
        { start: '08:00', end: '20:00', shift_type: 'long_day', count: 3, notes: 'Long day' },
        { start: '20:00', end: '08:00', shift_type: 'night-wake', count: 2, notes: 'Waking night (x2)' },
      ],
    },
  },
  {
    key: 'cedar',
    name: 'Cedar House',
    type: 'supported_living',
    address: '21 Cedar Grove',
    city: 'Sheffield',
    postcode: 'S10 3FL',
    phone: '+441140000005',
    email: 'cedar@myrotapro.com',
    capacity: 6,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      name: 'Cedar House Personal Care & Support',
      description: 'Early/late split cover with sleep-in night at Cedar House.',
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 7.5,
      is_24_hour: true,
      priority_level: 'high',
    },
    // Pattern: early / late / sleep-in night (every day)
    pattern: {
      all: [
        { start: '07:00', end: '14:30', shift_type: 'morning', count: 2, notes: 'Early' },
        { start: '14:30', end: '22:00', shift_type: 'afternoon', count: 2, notes: 'Late' },
        { start: '22:00', end: '07:00', shift_type: 'night-sleep', count: 1, notes: 'Sleep-in night' },
      ],
    },
  },

  // ---- Community outreach (daytime, no overnight) --------------------------
  {
    key: 'elm',
    name: 'Elm Community Outreach',
    type: 'community_outreach',
    address: '5 Elm Street',
    city: 'Nottingham',
    postcode: 'NG7 2RD',
    phone: '+441150000006',
    email: 'elm@myrotapro.com',
    capacity: 20,
    operating_hours: { start: '08:00', end: '21:00' },
    service: {
      name: 'Elm Community Support',
      description: 'Community outreach visits and social support across Nottingham.',
      category: 'social',
      required_skills: ['social_support', 'domestic_support'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 6,
      is_24_hour: false,
      priority_level: 'medium',
    },
    // Pattern: morning + evening visiting rounds, Mon–Sat (Sunday closed)
    pattern: {
      byDay: {
        monday: sixDayOutreach(),
        tuesday: sixDayOutreach(),
        wednesday: sixDayOutreach(),
        thursday: sixDayOutreach(),
        friday: sixDayOutreach(),
        saturday: sixDayOutreach(),
        // sunday inactive
      },
    },
  },
  {
    key: 'rowan',
    name: 'Rowan Community Outreach',
    type: 'community_outreach',
    address: '90 Rowan Way',
    city: 'Bristol',
    postcode: 'BS7 8QN',
    phone: '+441170000007',
    email: 'rowan@myrotapro.com',
    capacity: 15,
    operating_hours: { start: '09:00', end: '17:00' },
    service: {
      name: 'Rowan Community Support',
      description: 'Weekday community support with lighter Saturday cover across Bristol.',
      category: 'social',
      required_skills: ['social_support', 'domestic_support'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 8,
      is_24_hour: false,
      priority_level: 'medium',
    },
    // Pattern: full weekday day cover, reduced Saturday, closed Sunday
    pattern: {
      byDay: {
        monday: [{ start: '09:00', end: '17:00', shift_type: 'day', count: 3, notes: 'Day support' }],
        tuesday: [{ start: '09:00', end: '17:00', shift_type: 'day', count: 3, notes: 'Day support' }],
        wednesday: [{ start: '09:00', end: '17:00', shift_type: 'day', count: 3, notes: 'Day support' }],
        thursday: [{ start: '09:00', end: '17:00', shift_type: 'day', count: 3, notes: 'Day support' }],
        friday: [{ start: '09:00', end: '17:00', shift_type: 'day', count: 3, notes: 'Day support' }],
        saturday: [{ start: '09:00', end: '15:00', shift_type: 'day', count: 1, notes: 'Weekend on-call cover' }],
        // sunday inactive
      },
    },
  },

  // ---- Day centre (daytime, weekdays only) --------------------------------
  {
    key: 'sunrise',
    name: 'Sunrise Day Centre',
    type: 'day_centre',
    address: '1 Sunrise Plaza',
    city: 'London',
    postcode: 'SE1 7PB',
    phone: '+442070000008',
    email: 'sunrise@myrotapro.com',
    capacity: 30,
    operating_hours: { start: '08:00', end: '18:00' },
    service: {
      name: 'Sunrise Day Activities & Social Support',
      description: 'Structured daytime activities and social support at Sunrise Day Centre.',
      category: 'social',
      required_skills: ['social_support'],
      min_staff_count: 2,
      max_staff_count: 5,
      duration_hours: 8.5,
      is_24_hour: false,
      priority_level: 'medium',
    },
    // Pattern: single daytime shift, Mon–Fri only
    pattern: {
      byDay: {
        monday: [{ start: '08:30', end: '17:00', shift_type: 'day', count: 4, notes: 'Day centre' }],
        tuesday: [{ start: '08:30', end: '17:00', shift_type: 'day', count: 4, notes: 'Day centre' }],
        wednesday: [{ start: '08:30', end: '17:00', shift_type: 'day', count: 4, notes: 'Day centre' }],
        thursday: [{ start: '08:30', end: '17:00', shift_type: 'day', count: 4, notes: 'Day centre' }],
        friday: [{ start: '08:30', end: '17:00', shift_type: 'day', count: 4, notes: 'Day centre' }],
        // saturday + sunday inactive
      },
    },
  },
];

function sixDayOutreach() {
  return [
    { start: '08:00', end: '14:00', shift_type: 'morning', count: 2, notes: 'Morning visits' },
    { start: '14:00', end: '21:00', shift_type: 'evening', count: 2, notes: 'Afternoon/evening visits' },
  ];
}

// ---------------------------------------------------------------------------
// Staff plan — 35 staff (18 FT / 12 PT / 5 bank) + 1 admin
// Allocation is weighted to each home's coverage load (Birchwood heaviest).
// `homes` lists the home keys a staff member belongs to; first entry is default.
// ---------------------------------------------------------------------------

const STAFF_PLAN = [
  // --- Home managers: one per home (8, all fulltime) ---------------------
  { role: 'home_manager', type: 'fulltime', homes: ['willow'] },
  { role: 'home_manager', type: 'fulltime', homes: ['oakwood'] },
  { role: 'home_manager', type: 'fulltime', homes: ['maple'] },
  { role: 'home_manager', type: 'fulltime', homes: ['birchwood'] },
  { role: 'home_manager', type: 'fulltime', homes: ['cedar'] },
  { role: 'home_manager', type: 'fulltime', homes: ['elm'] },
  { role: 'home_manager', type: 'fulltime', homes: ['rowan'] },
  { role: 'home_manager', type: 'fulltime', homes: ['sunrise'] },

  // --- Senior staff (6): 5 SL homes + a 2nd senior for heavy Birchwood ---
  { role: 'senior_staff', type: 'fulltime', homes: ['willow'] },
  { role: 'senior_staff', type: 'fulltime', homes: ['oakwood'] },
  { role: 'senior_staff', type: 'fulltime', homes: ['maple'] },
  { role: 'senior_staff', type: 'fulltime', homes: ['birchwood'] },
  { role: 'senior_staff', type: 'parttime', homes: ['cedar'] },
  { role: 'senior_staff', type: 'parttime', homes: ['birchwood'] },

  // --- Support workers, fulltime remainder (6) --------------------------
  { role: 'support_worker', type: 'fulltime', homes: ['birchwood'] },
  { role: 'support_worker', type: 'fulltime', homes: ['birchwood'] },
  { role: 'support_worker', type: 'fulltime', homes: ['maple'] },
  { role: 'support_worker', type: 'fulltime', homes: ['maple'] },
  { role: 'support_worker', type: 'fulltime', homes: ['willow'] },
  { role: 'support_worker', type: 'fulltime', homes: ['oakwood'] },

  // --- Support workers, parttime (10) -----------------------------------
  { role: 'support_worker', type: 'parttime', homes: ['birchwood'] },
  { role: 'support_worker', type: 'parttime', homes: ['birchwood'] },
  { role: 'support_worker', type: 'parttime', homes: ['maple'] },
  { role: 'support_worker', type: 'parttime', homes: ['willow'] },
  { role: 'support_worker', type: 'parttime', homes: ['oakwood'] },
  { role: 'support_worker', type: 'parttime', homes: ['cedar'] },
  { role: 'support_worker', type: 'parttime', homes: ['cedar'] },
  { role: 'support_worker', type: 'parttime', homes: ['elm'] },
  { role: 'support_worker', type: 'parttime', homes: ['rowan'] },
  { role: 'support_worker', type: 'parttime', homes: ['sunrise'] },

  // --- Bank staff (5): float across multiple homes for flexible cover ----
  { role: 'support_worker', type: 'bank', homes: ['willow', 'oakwood'] },
  { role: 'support_worker', type: 'bank', homes: ['maple', 'birchwood'] },
  { role: 'support_worker', type: 'bank', homes: ['cedar', 'birchwood'] },
  { role: 'support_worker', type: 'bank', homes: ['elm', 'rowan', 'sunrise'] },
  { role: 'support_worker', type: 'bank', homes: ['willow', 'maple', 'cedar'] },
];

const FIRST_NAMES = [
  'Alice', 'Bardia', 'Chidi', 'Deborah', 'Emeka', 'Farah', 'Gemma', 'Hassan',
  'Imani', 'Jacob', 'Kelechi', 'Lucia', 'Marcus', 'Naomi', 'Oscar', 'Priya',
  'Quintin', 'Rosa', 'Samuel', 'Tara', 'Uche', 'Valentina', 'Wesley', 'Ximena',
  'Yusuf', 'Zainab', 'Aaron', 'Bianca', 'Callum', 'Delphine', 'Elias', 'Freya',
  'Gerald', 'Halima', 'Isaac', 'Jasmine', 'Kofi',
];

const LAST_NAMES = [
  'Adeyemi', 'Bennett', 'Costa', 'Dhillon', 'Evans', 'Fernandez', 'Gallagher',
  'Hughes', 'Ibrahim', 'Jenkins', 'Kaur', 'Lawson', 'Mensah', 'Nowak', 'Owusu',
  'Patel', 'Quinn', 'Reyes', 'Sharma', 'Thompson', 'Ugwu', 'Vasquez', 'Walsh',
  'Xu', 'Yates', 'Zaman', 'Ahmed', 'Brooks', 'Carter', 'Duffy', 'Ellison',
  'Foster', 'Grant', 'Holt', 'Iqbal', 'Jones', 'Kelly',
];

function hoursForType(type) {
  switch (type) {
    case 'fulltime':
      return { min_hours_per_week: 37.5, max_hours_per_week: 40 };
    case 'parttime':
      return { min_hours_per_week: 16, max_hours_per_week: 24 };
    case 'bank':
    default:
      return { min_hours_per_week: 0, max_hours_per_week: 30 };
  }
}

function skillsForRole(role) {
  if (role === 'senior_staff' || role === 'home_manager') {
    return ['medication', 'personal_care', 'domestic_support', 'social_support', 'specialist_care'];
  }
  return ['personal_care', 'domestic_support', 'social_support'];
}

// ---------------------------------------------------------------------------
// Build a WeeklySchedule.schedule document from a home's pattern definition
// ---------------------------------------------------------------------------

function buildSchedule(pattern, serviceId) {
  const schedule = {};
  for (const day of DAYS) {
    let shifts = [];
    if (pattern.all) {
      shifts = pattern.all;
    } else if (pattern.byDay && pattern.byDay[day]) {
      shifts = pattern.byDay[day];
    }
    schedule[day] = {
      is_active: shifts.length > 0,
      shifts: shifts.map((s) => ({
        service_id: serviceId,
        start_time: s.start,
        end_time: s.end,
        shift_type: s.shift_type,
        required_staff_count: s.count,
        notes: s.notes,
      })),
    };
  }
  return schedule;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seed() {
  console.log('🔌 Connecting to MongoDB:', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected\n');

  // --- Wipe & reseed --------------------------------------------------------
  console.log('🧹 Clearing existing data (wipe & reseed)...');
  const collectionsToClear = [
    'users', 'homes', 'services', 'weeklyschedules',
    'shifts', 'timetables', 'availabilities', 'rotas',
  ];
  for (const coll of collectionsToClear) {
    try {
      await mongoose.connection.db.collection(coll).deleteMany({});
      console.log(`   • cleared ${coll}`);
    } catch (err) {
      // collection may not exist yet — ignore
    }
  }
  console.log('');

  // --- Homes ---------------------------------------------------------------
  console.log('🏠 Creating homes...');
  const homeByKey = {};
  for (const def of HOME_DEFS) {
    const home = await Home.create({
      name: def.name,
      location: { address: def.address, city: def.city, postcode: def.postcode },
      contact_info: { phone: def.phone, email: def.email },
      capacity: def.capacity,
      operating_hours: def.operating_hours,
      is_active: true,
    });
    homeByKey[def.key] = home;
    console.log(`   • ${def.name} (${prettyType(def.type)})`);
  }
  console.log('');

  // --- Services (1 per home) -----------------------------------------------
  console.log('🧩 Creating services...');
  const serviceByKey = {};
  for (const def of HOME_DEFS) {
    const home = homeByKey[def.key];
    const svc = await Service.create({
      ...def.service,
      home_ids: [home._id],
      is_active: true,
    });
    serviceByKey[def.key] = svc;
    console.log(`   • ${def.service.name}`);
  }
  console.log('');

  // --- WeeklySchedules (shift pattern templates) ---------------------------
  console.log('📅 Creating shift pattern templates (WeeklySchedules)...');
  for (const def of HOME_DEFS) {
    const home = homeByKey[def.key];
    const svc = serviceByKey[def.key];
    const schedule = buildSchedule(def.pattern, svc._id);
    const ws = await WeeklySchedule.create({
      home_id: home._id,
      schedule,
      is_active: true,
    });
    const activeDays = DAYS.filter((d) => schedule[d].is_active).length;
    console.log(
      `   • ${def.name}: ${describePattern(def.pattern)} ` +
        `(${activeDays} active days, ${ws.totalWeeklyShifts} shifts/wk, ${ws.totalWeeklyHours}h/wk)`,
    );
  }
  console.log('');

  // --- Admin ---------------------------------------------------------------
  console.log('👤 Creating admin...');
  await User.create({
    name: 'System Administrator',
    email: 'admin@myrotapro.com',
    phone: '+442070000000',
    password: COMMON_PASSWORD,
    role: 'admin',
    type: 'fulltime',
    min_hours_per_week: 37.5,
    max_hours_per_week: 40,
    homes: [],
    is_active: true,
    skills: skillsForRole('admin'),
  });
  console.log('   • admin@myrotapro.com\n');

  // --- Staff ---------------------------------------------------------------
  console.log('🧑‍🤝‍🧑 Creating 35 staff and allocating to homes...');
  const perHomeCount = {};

  for (let i = 0; i < STAFF_PLAN.length; i++) {
    const plan = STAFF_PLAN[i];

    // Unique name: pair first/last by index (both lists are >= STAFF_PLAN.length)
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[i % LAST_NAMES.length];
    const name = `${first} ${last}`;
    const email = `${first}.${last}.${i + 1}@myrotapro.com`.toLowerCase();
    const phone = `+44160${String(1000000 + i).slice(-7)}`;
    const hours = hoursForType(plan.type);

    const homes = plan.homes.map((k, idx) => ({
      home_id: homeByKey[k]._id,
      is_default: idx === 0,
    }));

    await User.create({
      name,
      email,
      phone,
      password: COMMON_PASSWORD,
      role: plan.role,
      type: plan.type,
      ...hours,
      homes,
      default_home_id: homeByKey[plan.homes[0]]._id,
      is_active: true,
      skills: skillsForRole(plan.role),
      preferred_shift_types: [],
    });

    plan.homes.forEach((k) => {
      perHomeCount[k] = (perHomeCount[k] || 0) + 1;
    });
  }

  // --- Summary -------------------------------------------------------------
  const counts = STAFF_PLAN.reduce(
    (acc, p) => {
      acc[p.type]++;
      acc.roles[p.role] = (acc.roles[p.role] || 0) + 1;
      return acc;
    },
    { fulltime: 0, parttime: 0, bank: 0, roles: {} },
  );

  console.log('\n✅ Seed complete!\n');
  console.log('────────────────────────────────────────────');
  console.log('SUMMARY');
  console.log('────────────────────────────────────────────');
  console.log(`Homes:            ${HOME_DEFS.length}`);
  console.log(`  • Supported living:   ${HOME_DEFS.filter((h) => h.type === 'supported_living').length}`);
  console.log(`  • Community outreach: ${HOME_DEFS.filter((h) => h.type === 'community_outreach').length}`);
  console.log(`  • Day centre:         ${HOME_DEFS.filter((h) => h.type === 'day_centre').length}`);
  console.log(`Services:         ${HOME_DEFS.length} (1 per home)`);
  console.log(`Shift templates:  ${HOME_DEFS.length} WeeklySchedules (1 per home, each distinct)`);
  console.log(`Users:            ${STAFF_PLAN.length} staff + 1 admin = ${STAFF_PLAN.length + 1}`);
  console.log(`  • fulltime:  ${counts.fulltime}`);
  console.log(`  • parttime:  ${counts.parttime}`);
  console.log(`  • bank:      ${counts.bank}`);
  console.log(`  • roles:     ${Object.entries(counts.roles).map(([r, n]) => `${r}=${n}`).join(', ')}, admin=1`);
  console.log('\nStaff allocated per home (incl. bank floaters):');
  for (const def of HOME_DEFS) {
    console.log(`  • ${def.name.padEnd(26)} ${perHomeCount[def.key] || 0} staff`);
  }
  console.log('\nAll users password: ' + COMMON_PASSWORD);
  console.log('Admin login:        admin@myrotapro.com');
  console.log('────────────────────────────────────────────');

  await mongoose.disconnect();
  console.log('\n🔌 Disconnected. Done.');
}

function prettyType(t) {
  return {
    supported_living: 'Supported Living',
    community_outreach: 'Community Outreach',
    day_centre: 'Day Centre',
  }[t] || t;
}

function describePattern(pattern) {
  const shifts = pattern.all || Object.values(pattern.byDay || {})[0] || [];
  return shifts.map((s) => `${s.start}-${s.end} ${s.shift_type} x${s.count}`).join(' | ');
}

seed().catch((err) => {
  console.error('\n❌ Seed failed:', err);
  mongoose.disconnect();
  process.exit(1);
});
