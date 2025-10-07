const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');

// Production MongoDB URI
const PRODUCTION_MONGODB_URI = 'mongodb+srv://chrisfonkeng:chrisfonkeng123@cluster0.8qj8x.mongodb.net/myrotapro?retryWrites=true&w=majority';

// Common password for all users
const COMMON_PASSWORD = 'passWord123#';

// Sample names for generating users
const FIRST_NAMES = [
  'Alice', 'Bob', 'Charlie', 'Diana', 'Edward', 'Fiona', 'George', 'Helen',
  'Ian', 'Julia', 'Kevin', 'Laura', 'Michael', 'Nina', 'Oliver', 'Paula',
  'Quentin', 'Rachel', 'Samuel', 'Tina', 'Ulysses', 'Victoria', 'William', 'Zoe',
  'Adam', 'Beth', 'Chris', 'Debra', 'Ethan', 'Grace', 'Henry', 'Isabel',
  'Jack', 'Kate', 'Liam', 'Maya', 'Noah', 'Olivia', 'Peter', 'Quinn'
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas',
  'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White',
  'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young',
  'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores'
];

// Skills for different roles
const SUPPORT_WORKER_SKILLS = ['medication', 'personal_care', 'domestic_support', 'social_support'];
const SENIOR_STAFF_SKILLS = ['medication', 'personal_care', 'domestic_support', 'social_support', 'specialist_care'];

// Preferred shift types
const SHIFT_TYPES = ['morning', 'afternoon', 'night', 'long_day'];

// Generate random name
function generateName() {
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${firstName} ${lastName}`;
}

// Generate unique email
function generateEmail(firstName, lastName, homeName, role) {
  const cleanFirstName = firstName.toLowerCase().replace(/\s+/g, '');
  const cleanLastName = lastName.toLowerCase().replace(/\s+/g, '');
  const cleanHomeName = homeName.toLowerCase().replace(/\s+/g, '');
  return `${cleanFirstName}.${cleanLastName}.${cleanHomeName}.${role}@myrotapro.com`;
}

// Generate random phone number
function generatePhone() {
  const prefixes = ['+441234', '+441235', '+441236', '+441237', '+441238'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = Math.floor(Math.random() * 900000) + 100000;
  return `${prefix}${suffix}`;
}

// Get random skills for role
function getRandomSkills(role) {
  const skills = role === 'senior_staff' ? SENIOR_STAFF_SKILLS : SUPPORT_WORKER_SKILLS;
  const numSkills = Math.floor(Math.random() * 3) + 2; // 2-4 skills
  const shuffled = skills.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, numSkills);
}

// Get random shift preferences
function getRandomShiftPreferences() {
  const numShifts = Math.floor(Math.random() * 3) + 1; // 1-3 preferences
  const shuffled = SHIFT_TYPES.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, numShifts);
}

// Create user data
function createUserData(name, email, phone, role, type, homeIds, isDefaultHome = false) {
  const [firstName, lastName] = name.split(' ');
  
  return {
    name,
    email,
    phone,
    password: COMMON_PASSWORD,
    role,
    type,
    homes: homeIds.map((homeId, index) => ({
      home_id: homeId,
      is_default: index === 0 && isDefaultHome
    })),
    default_home_id: isDefaultHome ? homeIds[0] : homeIds[0],
    min_hours_per_week: type === 'fulltime' ? 40 : type === 'parttime' ? 20 : 0,
    max_hours_per_week: type === 'fulltime' ? 40 : type === 'parttime' ? 30 : 20,
    skills: getRandomSkills(role),
    preferred_shift_types: getRandomShiftPreferences(),
    is_active: true
  };
}

async function seedProductionUsers() {
  try {
    console.log('🌱 Starting production user seeding...');
    
    // Connect to production database
    await mongoose.connect(PRODUCTION_MONGODB_URI);
    console.log('✅ Connected to production database');

    // Get all homes and services
    const homes = await Home.find({ is_active: true });
    const services = await Service.find({ is_active: true });
    
    console.log(`📊 Found ${homes.length} homes and ${services.length} services`);

    // Create a map of services by home
    const servicesByHome = {};
    services.forEach(service => {
      service.home_ids.forEach(homeId => {
        if (!servicesByHome[homeId]) {
          servicesByHome[homeId] = [];
        }
        servicesByHome[homeId].push(service);
      });
    });

    const usersToCreate = [];
    const createdEmails = new Set();

    // Process each home
    for (const home of homes) {
      console.log(`\n🏠 Processing home: ${home.name}`);
      
      const homeServices = servicesByHome[home._id] || [];
      const hasOutreachService = homeServices.some(service => 
        service.name.toLowerCase().includes('outreach') || 
        service.name.toLowerCase().includes('community')
      );

      if (hasOutreachService) {
        console.log(`  📋 ${home.name} has outreach service - creating 1-2 staff only`);
        
        // Create 1-2 staff for outreach homes (no senior staff)
        const numStaff = Math.floor(Math.random() * 2) + 1; // 1-2 staff
        
        for (let i = 0; i < numStaff; i++) {
          const name = generateName();
          const email = generateEmail(name.split(' ')[0], name.split(' ')[1], home.name, 'support_worker');
          
          if (!createdEmails.has(email)) {
            const userData = createUserData(
              name,
              email,
              generatePhone(),
              'support_worker',
              'fulltime',
              [home._id],
              true
            );
            usersToCreate.push(userData);
            createdEmails.add(email);
          }
        }
      } else {
        console.log(`  🏘️ ${home.name} is a regular home - creating full staffing`);
        
        // Regular homes get full staffing
        // 1. Create 4 fulltime users (3 support_worker + 1 senior_staff)
        for (let i = 0; i < 3; i++) {
          const name = generateName();
          const email = generateEmail(name.split(' ')[0], name.split(' ')[1], home.name, 'support_worker');
          
          if (!createdEmails.has(email)) {
            const userData = createUserData(
              name,
              email,
              generatePhone(),
              'support_worker',
              'fulltime',
              [home._id],
              true
            );
            usersToCreate.push(userData);
            createdEmails.add(email);
          }
        }
        
        // Senior staff
        const seniorName = generateName();
        const seniorEmail = generateEmail(seniorName.split(' ')[0], seniorName.split(' ')[1], home.name, 'senior_staff');
        
        if (!createdEmails.has(seniorEmail)) {
          const seniorData = createUserData(
            seniorName,
            seniorEmail,
            generatePhone(),
            'senior_staff',
            'fulltime',
            [home._id],
            true
          );
          usersToCreate.push(seniorData);
          createdEmails.add(seniorEmail);
        }

        // 2. Create 2 parttime users
        for (let i = 0; i < 2; i++) {
          const name = generateName();
          const email = generateEmail(name.split(' ')[0], name.split(' ')[1], home.name, 'parttime');
          
          if (!createdEmails.has(email)) {
            const userData = createUserData(
              name,
              email,
              generatePhone(),
              'support_worker',
              'parttime',
              [home._id],
              false
            );
            usersToCreate.push(userData);
            createdEmails.add(email);
          }
        }

        // 3. Create 2 bank workers
        for (let i = 0; i < 2; i++) {
          const name = generateName();
          const email = generateEmail(name.split(' ')[0], name.split(' ')[1], home.name, 'bank');
          
          if (!createdEmails.has(email)) {
            const userData = createUserData(
              name,
              email,
              generatePhone(),
              'support_worker',
              'bank',
              [home._id],
              false
            );
            usersToCreate.push(userData);
            createdEmails.add(email);
          }
        }
      }
    }

    // 4. Create cross-home workers (2 workers from each home can work in another home)
    console.log('\n🔄 Creating cross-home workers...');
    
    const supportedLivingHomes = homes.filter(home => {
      const homeServices = servicesByHome[home._id] || [];
      return homeServices.some(service => service.name.toLowerCase().includes('supported living'));
    });

    for (const home of supportedLivingHomes) {
      // Find another supported living home to cross-assign
      const otherHomes = supportedLivingHomes.filter(h => h._id.toString() !== home._id.toString());
      
      if (otherHomes.length > 0) {
        const otherHome = otherHomes[Math.floor(Math.random() * otherHomes.length)];
        
        // Create 2 cross-home workers
        for (let i = 0; i < 2; i++) {
          const name = generateName();
          const email = generateEmail(name.split(' ')[0], name.split(' ')[1], home.name, 'cross');
          
          if (!createdEmails.has(email)) {
            const userData = createUserData(
              name,
              email,
              generatePhone(),
              'support_worker',
              'fulltime',
              [home._id, otherHome._id],
              true // Default home is the first one
            );
            usersToCreate.push(userData);
            createdEmails.add(email);
          }
        }
      }
    }

    console.log(`\n👥 Total users to create: ${usersToCreate.length}`);

    // Create users in batches to avoid memory issues
    const batchSize = 50;
    let createdCount = 0;

    for (let i = 0; i < usersToCreate.length; i += batchSize) {
      const batch = usersToCreate.slice(i, i + batchSize);
      
      try {
        const createdUsers = await User.insertMany(batch, { ordered: false });
        createdCount += createdUsers.length;
        console.log(`✅ Created batch ${Math.floor(i / batchSize) + 1}: ${createdUsers.length} users`);
      } catch (error) {
        if (error.code === 11000) {
          // Handle duplicate key errors
          console.log(`⚠️ Some users in batch ${Math.floor(i / batchSize) + 1} already exist, skipping duplicates`);
          createdCount += batch.length - error.result.result.writeErrors.length;
        } else {
          console.error(`❌ Error creating batch ${Math.floor(i / batchSize) + 1}:`, error.message);
        }
      }
    }

    // Summary
    console.log('\n📊 SEEDING SUMMARY:');
    console.log(`🏠 Homes processed: ${homes.length}`);
    console.log(`👥 Users created: ${createdCount}`);
    console.log(`📧 Unique emails: ${createdEmails.size}`);
    
    // Show breakdown by role
    const roleCounts = usersToCreate.reduce((acc, user) => {
      acc[user.role] = (acc[user.role] || 0) + 1;
      return acc;
    }, {});
    
    console.log('\n📈 Users by role:');
    Object.entries(roleCounts).forEach(([role, count]) => {
      console.log(`  ${role}: ${count}`);
    });

    // Show breakdown by type
    const typeCounts = usersToCreate.reduce((acc, user) => {
      acc[user.type] = (acc[user.type] || 0) + 1;
      return acc;
    }, {});
    
    console.log('\n📈 Users by employment type:');
    Object.entries(typeCounts).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    console.log('\n🎉 Production user seeding completed successfully!');
    console.log('🔑 All users have password: passWord123#');
    console.log('📧 All emails end with: @myrotapro.com');

  } catch (error) {
    console.error('❌ Error seeding users:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database');
  }
}

// Run the seeding script
if (require.main === module) {
  seedProductionUsers();
}

module.exports = { seedProductionUsers };
