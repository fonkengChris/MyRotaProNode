const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config({ path: '../env.example' });

// Test users configuration
const testUsers = [
  // 10 Support Workers
  { name: 'John Support', role: 'support_worker', email: 'john_support@rcs.com' },
  { name: 'Sarah Support', role: 'support_worker', email: 'sarah_support@rcs.com' },
  { name: 'Mike Support', role: 'support_worker', email: 'mike_support@rcs.com' },
  { name: 'Emma Support', role: 'support_worker', email: 'emma_support@rcs.com' },
  { name: 'David Support', role: 'support_worker', email: 'david_support@rcs.com' },
  { name: 'Lisa Support', role: 'support_worker', email: 'lisa_support@rcs.com' },
  { name: 'Tom Support', role: 'support_worker', email: 'tom_support@rcs.com' },
  { name: 'Anna Support', role: 'support_worker', email: 'anna_support@rcs.com' },
  { name: 'James Support', role: 'support_worker', email: 'james_support@rcs.com' },
  { name: 'Maria Support', role: 'support_worker', email: 'maria_support@rcs.com' },
  
  // 5 Senior Staff
  { name: 'John Senior', role: 'senior_staff', email: 'john_senior@rcs.com' },
  { name: 'Sarah Senior', role: 'senior_staff', email: 'sarah_senior@rcs.com' },
  { name: 'Mike Senior', role: 'senior_staff', email: 'mike_senior@rcs.com' },
  { name: 'Emma Senior', role: 'senior_staff', email: 'emma_senior@rcs.com' },
  { name: 'David Senior', role: 'senior_staff', email: 'david_senior@rcs.com' },
  
  // 1 Home Manager
  { name: 'John Manager', role: 'home_manager', email: 'john_manager@rcs.com' },
  
  // 1 Admin
  { name: 'John Admin', role: 'admin', email: 'john_admin@rcs.com' }
];

const commonPassword = 'passWord123';
const commonPhone = '+44123456789';

async function createTestUsers() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB');

    // Clear existing test users (optional - comment out if you want to keep existing ones)
    // await User.deleteMany({ email: { $regex: /@rcs\.com$/ } });
    // console.log('Cleared existing test users');

    const createdUsers = [];
    const errors = [];

    for (const userData of testUsers) {
      try {
        // Check if user already exists
        const existingUser = await User.findOne({ email: userData.email });
        if (existingUser) {
          console.log(`User ${userData.email} already exists, skipping...`);
          continue;
        }

        // Create user
        const user = new User({
          name: userData.name,
          email: userData.email,
          phone: commonPhone,
          password: commonPassword,
          role: userData.role,
          type: 'fulltime', // Default to fulltime for test users
          is_active: true,
          skills: ['personal_care', 'domestic_support', 'social_support'],
          preferred_shift_types: ['morning', 'afternoon'],
          max_hours_per_week: 40
        });

        await user.save();
        createdUsers.push({
          name: user.name,
          email: user.email,
          role: user.role,
          id: user._id
        });

        console.log(`✅ Created user: ${user.name} (${user.role}) - ${user.email}`);
      } catch (error) {
        console.error(`❌ Failed to create user ${userData.email}:`, error.message);
        errors.push({ email: userData.email, error: error.message });
      }
    }

    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`✅ Successfully created: ${createdUsers.length} users`);
    console.log(`❌ Failed to create: ${errors.length} users`);
    
    if (createdUsers.length > 0) {
      console.log('\n👥 Created Users:');
      createdUsers.forEach(user => {
        console.log(`  - ${user.name} (${user.role}) - ${user.email}`);
      });
    }

    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach(error => {
        console.log(`  - ${error.email}: ${error.error}`);
      });
    }

    console.log('\n🔑 All users have password: passWord123');
    console.log('📱 All users have phone: +44123456789');

  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Run the script
if (require.main === module) {
  createTestUsers();
}

module.exports = { createTestUsers };
