/**
 * seedProductionOrg.js
 *
 * Seeds the REAL RCS organisation (from seed-instructions.txt) into the database
 * pointed to by MONGODB_URI:
 *
 *   - 22 homes:
 *       • 8 supported living (24h), with gender restrictions (male/female/mixed)
 *       • 3 Derby community-outreach homes (male)
 *       • 11 Nottingham community-outreach homes (male) — short visit patterns
 *   - 1 service per home (drives skills/staffing for the rota generator)
 *   - 1 WeeklySchedule ("shift pattern template") per home, built straight from
 *     the shift patterns in seed-instructions.txt
 *   - 55 users: 3 admins, 5 key workers (1 male, 4 female),
 *       47 support workers (30 fulltime, 12 parttime, 5 bank)
 *
 * GENDER is NOT stored on any document (User/Home have no gender field). It is
 * used only to (a) allocate staff to gender-appropriate homes — male staff to
 * male-only + mixed + outreach homes, female staff to female-only + mixed — and
 * (b) pick a matching first name. Home gender restriction lives only in this
 * seed data (surfaced in each home's service description + notes).
 *
 * All users share the password: Password123#   (hashed by the User pre-save hook)
 * Email domain (users + home contacts): @rcs_rota.co.uk
 *
 * Usage (WIPE & RESEED — destructive):
 *   node scripts/seedProductionOrg.js --confirm
 *   SEED_CONFIRM=1 node scripts/seedProductionOrg.js
 *   MONGODB_URI=mongodb://localhost:27017/myrotapro_seedtest \
 *     node scripts/seedProductionOrg.js --confirm
 *
 * Refuses to run without --confirm / SEED_CONFIRM=1, and prints the target DB
 * and the collections it will wipe first.
 *
 * NOTE: This clears Users, Homes, Services, WeeklySchedules and dependent
 * scheduling data (Shifts, Timetables, Availability, Rotas) before seeding.
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
const EMAIL_DOMAIN = 'rcsrota.co.uk';
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
// Pattern helpers
// ---------------------------------------------------------------------------

// "core" 24h cover shared by most supported-living homes: long day + waking night
function coreDayNight() {
  return [
    { start: '08:00', end: '20:00', shift_type: 'long_day', count: 2, notes: 'Long day' },
    { start: '20:00', end: '08:00', shift_type: 'night-wake', count: 1, notes: 'Waking night' },
  ];
}

// ---------------------------------------------------------------------------
// Home + service + shift-pattern definitions
//   gender: 'male' | 'female' | 'mixed'  (used for staff allocation only)
//   pattern.all   -> same shifts every day
//   pattern.byDay -> per-day shifts (missing days are inactive)
// ---------------------------------------------------------------------------

const HOME_DEFS = [
  // ===== Supported living (24h) ============================================
  {
    key: 'maple',
    name: 'Maple House',
    type: 'supported_living',
    gender: 'male',
    address: '14 Sydney Street',
    city: 'Burton on Trent',
    postcode: 'DE14 2LP',
    phone: '+441283500101',
    capacity: 6,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    pattern: { all: coreDayNight() },
  },
  {
    key: 'oakfield',
    name: 'Oakfield House',
    type: 'supported_living',
    gender: 'mixed',
    address: '27 High Street',
    city: 'Burton on Trent',
    postcode: 'DE14 1JQ',
    phone: '+441283500102',
    capacity: 7,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 4,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    pattern: {
      all: [
        ...coreDayNight(),
        { start: '10:00', end: '18:00', shift_type: 'day', count: 1, notes: 'Extra staff cover' },
      ],
    },
  },
  {
    key: 'rosewood',
    name: 'Rosewood Lodge',
    type: 'supported_living',
    gender: 'mixed',
    address: '8 Park Road',
    city: 'Swadlincote',
    postcode: 'DE11 0AB',
    phone: '+441283500103',
    capacity: 7,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 4,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    pattern: {
      all: [
        ...coreDayNight(),
        { start: '09:00', end: '17:00', shift_type: 'day', count: 1, notes: 'Extra staff cover' },
      ],
    },
  },
  {
    key: 'cedar',
    name: 'Cedar House',
    type: 'supported_living',
    gender: 'male',
    address: '45 Pelham Street',
    city: 'Derby',
    postcode: 'DE1 2WN',
    phone: '+441332500104',
    capacity: 6,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    pattern: { all: coreDayNight() },
  },
  {
    key: 'riverside',
    name: 'Riverside House',
    type: 'supported_living',
    gender: 'female',
    address: '12 Trent Street',
    city: 'Derby',
    postcode: 'DE1 2PW',
    phone: '+441332500105',
    capacity: 8,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 4,
      duration_hours: 8,
      is_24_hour: true,
      priority_level: 'high',
    },
    // Three-shift model + extra day cover
    pattern: {
      all: [
        { start: '07:00', end: '15:00', shift_type: 'morning', count: 2, notes: 'Morning' },
        { start: '15:00', end: '23:00', shift_type: 'evening', count: 2, notes: 'Late' },
        { start: '23:00', end: '07:00', shift_type: 'night-wake', count: 1, notes: 'Waking night' },
        { start: '09:00', end: '17:00', shift_type: 'day', count: 1, notes: 'Extra staff cover' },
      ],
    },
  },
  {
    key: 'willowcourt',
    name: 'Willow Court',
    type: 'supported_living',
    gender: 'male',
    address: '33 Moss Street',
    city: 'Derby',
    postcode: 'DE1 3LX',
    phone: '+441332500106',
    capacity: 6,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    // Sleep-in night (per instructions: "sleep")
    pattern: {
      all: [
        { start: '08:00', end: '20:00', shift_type: 'long_day', count: 2, notes: 'Long day' },
        { start: '21:00', end: '06:00', shift_type: 'night-sleep', count: 1, notes: 'Sleep-in night' },
      ],
    },
  },
  {
    key: 'bluebell',
    name: 'Bluebell House',
    type: 'supported_living',
    gender: 'female',
    address: '6 Cotton Lane',
    city: 'Derby',
    postcode: 'DE24 8GP',
    phone: '+441332500107',
    capacity: 6,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    pattern: {
      all: [
        ...coreDayNight(),
        { start: '16:00', end: '20:00', shift_type: 'evening', count: 1, notes: 'Extra staff cover' },
      ],
    },
  },
  {
    key: 'hawthorn',
    name: 'Hawthorn House',
    type: 'supported_living',
    gender: 'female',
    address: '21 Broadfield Close',
    city: 'Derby',
    postcode: 'DE22 3AA',
    phone: '+441332500108',
    capacity: 6,
    operating_hours: { start: '00:00', end: '23:59' },
    service: {
      category: 'personal_care',
      required_skills: ['personal_care', 'medication'],
      min_staff_count: 1,
      max_staff_count: 3,
      duration_hours: 12,
      is_24_hour: true,
      priority_level: 'high',
    },
    pattern: {
      all: [
        ...coreDayNight(),
        { start: '10:00', end: '15:00', shift_type: 'day', count: 1, notes: 'Extra staff cover' },
      ],
    },
  },

  // ===== Derby community outreach (male) ===================================
  {
    key: 'derby_outreach_1',
    name: 'Ashgrove Outreach',
    type: 'outreach',
    gender: 'male',
    address: '3 Ashgrove Court',
    city: 'Derby',
    postcode: 'DE1 1AA',
    phone: '+441332500201',
    capacity: 1,
    operating_hours: { start: '08:00', end: '18:00' },
    service: {
      category: 'social',
      required_skills: ['social_support', 'domestic_support'],
      min_staff_count: 1,
      max_staff_count: 1,
      duration_hours: 1,
      is_24_hour: false,
      priority_level: 'medium',
    },
    // Every day 08:30-09:30
    pattern: {
      byDay: DAYS.reduce((acc, d) => {
        acc[d] = [{ start: '08:30', end: '09:30', shift_type: 'morning', count: 1, notes: 'Outreach visit' }];
        return acc;
      }, {}),
    },
  },
  {
    key: 'derby_outreach_2',
    name: 'Elmtree Outreach',
    type: 'outreach',
    gender: 'male',
    address: '9 Elmtree Avenue',
    city: 'Derby',
    postcode: 'DE1 1BB',
    phone: '+441332500202',
    capacity: 1,
    operating_hours: { start: '08:00', end: '18:00' },
    service: {
      category: 'social',
      required_skills: ['social_support', 'domestic_support'],
      min_staff_count: 1,
      max_staff_count: 1,
      duration_hours: 3,
      is_24_hour: false,
      priority_level: 'medium',
    },
    // Wednesdays 10:00-13:00
    pattern: {
      byDay: {
        wednesday: [{ start: '10:00', end: '13:00', shift_type: 'day', count: 1, notes: 'Outreach visit' }],
      },
    },
  },
  {
    key: 'derby_outreach_3',
    name: 'Fernbank Outreach',
    type: 'outreach',
    gender: 'male',
    address: '17 Fernbank Road',
    city: 'Derby',
    postcode: 'DE1 1CC',
    phone: '+441332500203',
    capacity: 1,
    operating_hours: { start: '08:00', end: '18:00' },
    service: {
      category: 'social',
      required_skills: ['social_support', 'domestic_support'],
      min_staff_count: 1,
      max_staff_count: 1,
      duration_hours: 4,
      is_24_hour: false,
      priority_level: 'medium',
    },
    // Tuesdays and Thursdays 13:00-17:00
    pattern: {
      byDay: {
        tuesday: [{ start: '13:00', end: '17:00', shift_type: 'afternoon', count: 1, notes: 'Outreach visit' }],
        thursday: [{ start: '13:00', end: '17:00', shift_type: 'afternoon', count: 1, notes: 'Outreach visit' }],
      },
    },
  },

  // ===== Nottingham community outreach (11, male) ==========================
  // Auto-generated below (short varied weekday visits). See buildNottinghamHomes().
];

// ---------------------------------------------------------------------------
// Nottingham outreach: 11 male homes with short, varied weekday visit patterns.
// Deterministic (index-seeded) so re-runs produce the same data.
// ---------------------------------------------------------------------------

const NOTTS_NAMES = [
  'Sherwood Outreach', 'Trentside Outreach', 'Bramcote Outreach', 'Wollaton Outreach',
  'Mapperley Outreach', 'Beeston Outreach', 'Carlton Outreach', 'Arnold Outreach',
  'Radford Outreach', 'Clifton Outreach', 'Bulwell Outreach',
];
const NOTTS_STREETS = [
  'Sherwood Rise', 'Trent Boulevard', 'Bramcote Lane', 'Wollaton Road', 'Mapperley Plains',
  'Station Road', 'Carlton Hill', 'Front Street', 'Radford Road', 'Farnborough Road', 'Main Street',
];
// Candidate short visit slots (30 min - 1 hr) with their natural shift_type.
const NOTTS_SLOTS = [
  { start: '08:00', end: '08:30', shift_type: 'morning' },
  { start: '09:00', end: '10:00', shift_type: 'morning' },
  { start: '11:00', end: '11:30', shift_type: 'morning' },
  { start: '12:00', end: '13:00', shift_type: 'day' },
  { start: '14:00', end: '15:00', shift_type: 'afternoon' },
  { start: '16:30', end: '17:30', shift_type: 'afternoon' },
];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

function buildNottinghamHomes() {
  const homes = [];
  for (let i = 0; i < 11; i++) {
    // 1-3 weekdays, chosen deterministically from the index.
    const numDays = (i % 3) + 1;
    const days = [];
    for (let d = 0; d < numDays; d++) {
      days.push(WEEKDAYS[(i + d * 2) % WEEKDAYS.length]);
    }
    const slot = NOTTS_SLOTS[i % NOTTS_SLOTS.length];

    const byDay = {};
    for (const day of days) {
      byDay[day] = [{
        start: slot.start,
        end: slot.end,
        shift_type: slot.shift_type,
        count: 1,
        notes: 'Outreach visit',
      }];
    }

    homes.push({
      key: `notts_outreach_${i + 1}`,
      name: NOTTS_NAMES[i],
      type: 'outreach',
      gender: 'male',
      address: `${5 + i * 4} ${NOTTS_STREETS[i]}`,
      city: 'Nottingham',
      postcode: `NG${(i % 9) + 1} ${(i % 9) + 1}${String.fromCharCode(65 + i)}${String.fromCharCode(70 + i)}`,
      phone: `+441159${String(500300 + i).slice(-6)}`,
      capacity: 1,
      operating_hours: { start: '08:00', end: '18:00' },
      service: {
        category: 'social',
        required_skills: ['social_support', 'domestic_support'],
        min_staff_count: 1,
        max_staff_count: 1,
        duration_hours: Math.max(0.5, slotHours(slot.start, slot.end)),
        is_24_hour: false,
        priority_level: 'low',
      },
      pattern: { byDay },
    });
  }
  return homes;
}

function slotHours(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em - (sh * 60 + sm)) / 60;
}

HOME_DEFS.push(...buildNottinghamHomes());

// ---------------------------------------------------------------------------
// Staff plan — 5 key workers + 47 support workers (+ 3 admins created separately)
//   Each entry: { role, type, gender, homes: [homeKey...] }  (first home = default)
//
// Gender capability: male staff -> male-only + mixed + outreach homes;
//                    female staff -> female-only + mixed homes.
//
// Home keys by gender:
//   male SL:    maple, cedar, willowcourt
//   female SL:  riverside, bluebell, hawthorn
//   mixed SL:   oakfield, rosewood
//   outreach (male): derby_outreach_1..3, notts_outreach_1..11
// ---------------------------------------------------------------------------

const MALE_SL = ['maple', 'cedar', 'willowcourt'];
const FEMALE_SL = ['riverside', 'bluebell', 'hawthorn'];
const MIXED_SL = ['oakfield', 'rosewood'];
const DERBY_OUTREACH = ['derby_outreach_1', 'derby_outreach_2', 'derby_outreach_3'];
const NOTTS_OUTREACH = Array.from({ length: 11 }, (_, i) => `notts_outreach_${i + 1}`);

const STAFF_PLAN = [];

// --- Key workers: 1 male, 4 female (per instructions) ----------------------
// Male KW anchors a male SL home; the 4 female KWs anchor the 3 female SL homes
// plus one mixed home. All fulltime, set as default for their home.
STAFF_PLAN.push(
  { role: 'key_worker', type: 'fulltime', gender: 'male', homes: ['maple'] },
  { role: 'key_worker', type: 'fulltime', gender: 'female', homes: ['riverside'] },
  { role: 'key_worker', type: 'fulltime', gender: 'female', homes: ['bluebell'] },
  { role: 'key_worker', type: 'fulltime', gender: 'female', homes: ['hawthorn'] },
  { role: 'key_worker', type: 'fulltime', gender: 'female', homes: ['oakfield'] },
);

// --- Support workers: 30 fulltime, 12 parttime, 5 bank = 47 -----------------
// Allocation weighted to coverage load: 24h SL homes carry the bulk; mixed homes
// shared; outreach homes get light cover attached to nearby staff. Genders are
// chosen so every male-only and female-only home is staffable.
//
// Male-capable homes need cover for: 3 male SL (24h) + 14 outreach (light).
// Female-capable homes need cover for: 3 female SL (24h).
// Mixed homes (2) can take either gender.

const SUPPORT_PLAN = [
  // ---- Fulltime (30) ----
  // Male SL core cover (maple already has 1 KW): 3 homes x ~3 FT each
  { type: 'fulltime', gender: 'male', homes: ['maple'] },
  { type: 'fulltime', gender: 'male', homes: ['maple'] },
  { type: 'fulltime', gender: 'male', homes: ['cedar'] },
  { type: 'fulltime', gender: 'male', homes: ['cedar'] },
  { type: 'fulltime', gender: 'male', homes: ['cedar'] },
  { type: 'fulltime', gender: 'male', homes: ['willowcourt'] },
  { type: 'fulltime', gender: 'male', homes: ['willowcourt'] },
  { type: 'fulltime', gender: 'male', homes: ['willowcourt'] },
  // Female SL core cover (each female SL already has 1 KW): ~3 FT each
  { type: 'fulltime', gender: 'female', homes: ['riverside'] },
  { type: 'fulltime', gender: 'female', homes: ['riverside'] },
  { type: 'fulltime', gender: 'female', homes: ['riverside'] },
  { type: 'fulltime', gender: 'female', homes: ['bluebell'] },
  { type: 'fulltime', gender: 'female', homes: ['bluebell'] },
  { type: 'fulltime', gender: 'female', homes: ['bluebell'] },
  { type: 'fulltime', gender: 'female', homes: ['hawthorn'] },
  { type: 'fulltime', gender: 'female', homes: ['hawthorn'] },
  { type: 'fulltime', gender: 'female', homes: ['hawthorn'] },
  // Mixed SL core cover: split male/female
  { type: 'fulltime', gender: 'male', homes: ['oakfield'] },
  { type: 'fulltime', gender: 'female', homes: ['oakfield'] },
  { type: 'fulltime', gender: 'male', homes: ['rosewood'] },
  { type: 'fulltime', gender: 'female', homes: ['rosewood'] },
  { type: 'fulltime', gender: 'male', homes: ['rosewood'] },
  // Male staff who also cover Derby outreach (attached to a male SL as default)
  { type: 'fulltime', gender: 'male', homes: ['cedar', 'derby_outreach_1', 'derby_outreach_2'] },
  { type: 'fulltime', gender: 'male', homes: ['willowcourt', 'derby_outreach_3'] },
  { type: 'fulltime', gender: 'male', homes: ['maple', 'derby_outreach_1'] },
  // Male staff covering Nottingham outreach cluster (default to outreach home)
  { type: 'fulltime', gender: 'male', homes: ['notts_outreach_1', 'notts_outreach_2', 'notts_outreach_3'] },
  { type: 'fulltime', gender: 'male', homes: ['notts_outreach_4', 'notts_outreach_5', 'notts_outreach_6'] },
  { type: 'fulltime', gender: 'male', homes: ['notts_outreach_7', 'notts_outreach_8'] },
  { type: 'fulltime', gender: 'male', homes: ['notts_outreach_9', 'notts_outreach_10', 'notts_outreach_11'] },
  { type: 'fulltime', gender: 'male', homes: ['oakfield'] },

  // ---- Parttime (12) ----
  { type: 'parttime', gender: 'male', homes: ['maple'] },
  { type: 'parttime', gender: 'male', homes: ['cedar'] },
  { type: 'parttime', gender: 'male', homes: ['willowcourt'] },
  { type: 'parttime', gender: 'female', homes: ['riverside'] },
  { type: 'parttime', gender: 'female', homes: ['bluebell'] },
  { type: 'parttime', gender: 'female', homes: ['hawthorn'] },
  { type: 'parttime', gender: 'female', homes: ['oakfield'] },
  { type: 'parttime', gender: 'male', homes: ['rosewood'] },
  { type: 'parttime', gender: 'male', homes: ['notts_outreach_1', 'notts_outreach_4'] },
  { type: 'parttime', gender: 'male', homes: ['notts_outreach_7', 'notts_outreach_9'] },
  { type: 'parttime', gender: 'male', homes: ['derby_outreach_2', 'derby_outreach_3'] },
  { type: 'parttime', gender: 'female', homes: ['riverside'] },

  // ---- Bank (5): float across multiple same-gender homes -------------------
  { type: 'bank', gender: 'male', homes: ['maple', 'cedar', 'willowcourt'] },
  { type: 'bank', gender: 'female', homes: ['riverside', 'bluebell', 'hawthorn'] },
  { type: 'bank', gender: 'male', homes: ['oakfield', 'rosewood', 'cedar'] },
  { type: 'bank', gender: 'female', homes: ['oakfield', 'rosewood', 'bluebell'] },
  { type: 'bank', gender: 'male', homes: ['notts_outreach_2', 'notts_outreach_5', 'derby_outreach_1'] },
];

for (const s of SUPPORT_PLAN) {
  STAFF_PLAN.push({ role: 'support_worker', ...s });
}

// ---------------------------------------------------------------------------
// Names (gender-specific first names + shared surnames)
// ---------------------------------------------------------------------------

const MALE_FIRST_NAMES = [
  'James', 'Mohammed', 'Daniel', 'Samuel', 'Oliver', 'Emeka', 'Hassan', 'Marcus',
  'Jacob', 'Wesley', 'Isaac', 'Kofi', 'Elias', 'Callum', 'Aaron', 'Gerald',
  'Oscar', 'Quintin', 'Uche', 'Yusuf', 'Chidi', 'Bardia', 'Kelechi', 'Victor',
  'Nathan', 'Louis', 'Ibrahim', 'Sean', 'Tobias', 'Reuben', 'Malachi', 'Dominic',
];
const FEMALE_FIRST_NAMES = [
  'Alice', 'Deborah', 'Farah', 'Gemma', 'Imani', 'Lucia', 'Naomi', 'Priya',
  'Rosa', 'Tara', 'Valentina', 'Ximena', 'Zainab', 'Bianca', 'Delphine', 'Freya',
  'Halima', 'Jasmine', 'Amara', 'Sofia', 'Chloe', 'Nadia', 'Yvonne', 'Grace',
];
const LAST_NAMES = [
  'Adeyemi', 'Bennett', 'Costa', 'Dhillon', 'Evans', 'Fernandez', 'Gallagher',
  'Hughes', 'Ibrahim', 'Jenkins', 'Kaur', 'Lawson', 'Mensah', 'Nowak', 'Owusu',
  'Patel', 'Quinn', 'Reyes', 'Sharma', 'Thompson', 'Ugwu', 'Vasquez', 'Walsh',
  'Xu', 'Yates', 'Zaman', 'Ahmed', 'Brooks', 'Carter', 'Duffy', 'Ellison',
  'Foster', 'Grant', 'Holt', 'Iqbal', 'Jones', 'Kelly', 'Marsh', 'Norton',
  'Osei', 'Payne', 'Reid', 'Stokes', 'Turner', 'Usman', 'Vaughan', 'Webb',
  'Yildiz', 'Zhang', 'Abbott', 'Barker', 'Clarke', 'Dawson', 'Ellis', 'Frost',
];

// ---------------------------------------------------------------------------
// Small reusable helpers (mirror seedFullOrganization.js)
// ---------------------------------------------------------------------------

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
  if (role === 'senior_staff' || role === 'key_worker') {
    return ['medication', 'personal_care', 'domestic_support', 'social_support', 'specialist_care'];
  }
  return ['personal_care', 'domestic_support', 'social_support'];
}

function serviceName(def) {
  return def.type === 'outreach'
    ? `${def.name} Community Support`
    : `${def.name} Personal Care & Support`;
}

function serviceDescription(def) {
  const g = { male: 'male', female: 'female', mixed: 'mixed' }[def.gender];
  return def.type === 'outreach'
    ? `Community outreach support (${g} service) for ${def.name}, ${def.city}.`
    : `24-hour personal care and support at ${def.name}, ${def.city} (${g} service).`;
}

function contactEmail(def) {
  const slug = def.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${slug}@${EMAIL_DOMAIN}`;
}

// Build a WeeklySchedule.schedule from a home's pattern definition.
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
  // --- Production guard -----------------------------------------------------
  const confirmed = process.argv.includes('--confirm') || process.env.SEED_CONFIRM === '1';

  console.log('🔌 Connecting to MongoDB:', redactUri(MONGODB_URI));
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected');
  console.log(`   Database: ${mongoose.connection.db.databaseName}\n`);

  const collectionsToClear = [
    'users', 'homes', 'services', 'weeklyschedules',
    'shifts', 'timetables', 'availabilities', 'rotas',
  ];

  if (!confirmed) {
    console.error('⛔ Refusing to run without confirmation.');
    console.error('   This is a WIPE & RESEED and will DELETE these collections:');
    console.error(`     ${collectionsToClear.join(', ')}`);
    console.error(`   Target DB: ${mongoose.connection.db.databaseName}`);
    console.error('\n   Re-run with --confirm  (or SEED_CONFIRM=1) to proceed.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // --- Wipe & reseed --------------------------------------------------------
  console.log('🧹 Clearing existing data (wipe & reseed)...');
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
      contact_info: { phone: def.phone, email: contactEmail(def) },
      capacity: def.capacity,
      operating_hours: def.operating_hours,
      is_active: true,
    });
    homeByKey[def.key] = home;
    console.log(`   • ${def.name.padEnd(22)} ${prettyType(def.type)} / ${def.gender} — ${def.address}, ${def.city}`);
  }
  console.log('');

  // --- Services (1 per home) -----------------------------------------------
  console.log('🧩 Creating services...');
  const serviceByKey = {};
  for (const def of HOME_DEFS) {
    const home = homeByKey[def.key];
    const svc = await Service.create({
      name: serviceName(def),
      description: serviceDescription(def),
      home_ids: [home._id],
      ...def.service,
      is_active: true,
    });
    serviceByKey[def.key] = svc;
  }
  console.log(`   • ${HOME_DEFS.length} services created (1 per home)\n`);

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
      `   • ${def.name.padEnd(22)} ${activeDays} active days, ` +
        `${ws.totalWeeklyShifts} shifts/wk, ${ws.totalWeeklyHours}h/wk`,
    );
  }
  console.log('');

  // --- Admins (3) ----------------------------------------------------------
  console.log('👤 Creating 3 admins...');
  const ADMINS = [
    { name: 'Grace Adeyemi (Admin)', email: `admin1@${EMAIL_DOMAIN}` },
    { name: 'Daniel Bennett (Admin)', email: `admin2@${EMAIL_DOMAIN}` },
    { name: 'Naomi Patel (Admin)', email: `admin3@${EMAIL_DOMAIN}` },
  ];
  for (let i = 0; i < ADMINS.length; i++) {
    const a = ADMINS[i];
    await User.create({
      name: a.name,
      email: a.email,
      phone: `+441332500${String(i + 1).padStart(3, '0')}`,
      password: COMMON_PASSWORD,
      role: 'admin',
      type: 'fulltime',
      min_hours_per_week: 37.5,
      max_hours_per_week: 40,
      homes: [],
      is_active: true,
      skills: skillsForRole('admin'),
    });
    console.log(`   • ${a.name} <${a.email}>`);
  }
  console.log('');

  // --- Staff (5 key workers + 47 support workers) --------------------------
  console.log(`🧑‍🤝‍🧑 Creating ${STAFF_PLAN.length} staff and allocating to homes...`);
  const perHomeCount = {};
  const nameUsage = {}; // ensure unique first.last combos
  let maleIdx = 0;
  let femaleIdx = 0;

  for (let i = 0; i < STAFF_PLAN.length; i++) {
    const plan = STAFF_PLAN[i];

    const first =
      plan.gender === 'male'
        ? MALE_FIRST_NAMES[maleIdx++ % MALE_FIRST_NAMES.length]
        : FEMALE_FIRST_NAMES[femaleIdx++ % FEMALE_FIRST_NAMES.length];
    const last = LAST_NAMES[i % LAST_NAMES.length];
    const name = `${first} ${last}`;

    // Unique email even if a first.last repeats
    const base = `${first}.${last}`.toLowerCase();
    nameUsage[base] = (nameUsage[base] || 0) + 1;
    const suffix = nameUsage[base] > 1 ? nameUsage[base] : i + 1;
    const email = `${base}.${suffix}@${EMAIL_DOMAIN}`;

    const phone = `+44161${String(2000000 + i).slice(-7)}`;
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
  printSummary(perHomeCount);

  await mongoose.disconnect();
  console.log('\n🔌 Disconnected. Done.');
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function prettyType(t) {
  return { supported_living: 'Supported Living', outreach: 'Outreach' }[t] || t;
}

function redactUri(uri) {
  return uri.replace(/(mongodb(?:\+srv)?:\/\/)[^@]*@/, '$1***:***@');
}

function printSummary(perHomeCount) {
  const roleCounts = { admin: 3, key_worker: 0, support_worker: 0 };
  const typeCounts = { fulltime: 0, parttime: 0, bank: 0 };
  const genderCounts = { male: 0, female: 0 };
  for (const p of STAFF_PLAN) {
    roleCounts[p.role]++;
    typeCounts[p.type]++;
    genderCounts[p.gender]++;
  }

  const sl = HOME_DEFS.filter((h) => h.type === 'supported_living');
  const out = HOME_DEFS.filter((h) => h.type === 'outreach');

  console.log('\n✅ Seed complete!\n');
  console.log('────────────────────────────────────────────');
  console.log('SUMMARY');
  console.log('────────────────────────────────────────────');
  console.log(`Homes:            ${HOME_DEFS.length}`);
  console.log(`  • Supported living: ${sl.length} (male ${sl.filter(h=>h.gender==='male').length}, female ${sl.filter(h=>h.gender==='female').length}, mixed ${sl.filter(h=>h.gender==='mixed').length})`);
  console.log(`  • Outreach:         ${out.length} (Derby 3, Nottingham 11 — all male)`);
  console.log(`Services:         ${HOME_DEFS.length} (1 per home)`);
  console.log(`Shift templates:  ${HOME_DEFS.length} WeeklySchedules (1 per home)`);
  console.log(`Users:            ${STAFF_PLAN.length + 3} (3 admin + ${STAFF_PLAN.length} staff)`);
  console.log(`  • roles:  admin=3, key_worker=${roleCounts.key_worker}, support_worker=${roleCounts.support_worker}`);
  console.log(`  • types:  fulltime=${typeCounts.fulltime}, parttime=${typeCounts.parttime}, bank=${typeCounts.bank}  (staff only)`);
  console.log(`  • gender (staff): male=${genderCounts.male}, female=${genderCounts.female}`);

  // Warn if any gender-restricted home has no same-gender staff.
  console.log('\nStaff allocated per home:');
  let unstaffed = 0;
  for (const def of HOME_DEFS) {
    const n = perHomeCount[def.key] || 0;
    const flag = n === 0 ? '  ⚠ UNSTAFFED' : '';
    if (n === 0) unstaffed++;
    console.log(`  • ${def.name.padEnd(22)} ${String(n).padStart(2)} staff  (${def.gender})${flag}`);
  }
  if (unstaffed > 0) {
    console.log(`\n⚠ ${unstaffed} home(s) have no directly-allocated staff (bank/outreach may still cover).`);
  }

  console.log('\nAll users password: ' + COMMON_PASSWORD);
  console.log(`Admin login:        admin1@${EMAIL_DOMAIN}`);
  console.log('────────────────────────────────────────────');
}

seed().catch((err) => {
  console.error('\n❌ Seed failed:', err);
  mongoose.disconnect();
  process.exit(1);
});
