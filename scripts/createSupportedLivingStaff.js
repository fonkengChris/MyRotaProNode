const mongoose = require('mongoose');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');
require('dotenv').config({ path: '../env.example' });

// Staff requirements for Supported Living service
const SUPPORTED_LIVING_REQUIREMENTS = {
  fulltime: 3,      // Including 1 senior staff
  parttime: 2,
  bank: 2
};

async function createSupportedLivingStaff() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB\n');

    // Find homes with Supported Living service
    const supportedLivingServices = await Service.find({
      is_active: true,
      $or: [
        { name: { $regex: /supported living/i } },
        { description: { $regex: /supported living/i } }
      ]
    });

    if (supportedLivingServices.length === 0) {
      console.log('❌ No Supported Living services found');
      return;
    }

    // Get home IDs from these services
    const supportedLivingHomeIds = [...new Set(
      supportedLivingServices.flatMap(service => service.home_ids)
    )];

    // Get the homes
    const supportedLivingHomes = await Home.find({
      _id: { $in: supportedLivingHomeIds },
      is_active: true
    }).sort({ name: 1 });

    console.log(`🏠 Found ${supportedLivingHomes.length} home(s) with Supported Living service\n`);

    const commonPassword = 'passWord123';
    const commonPhone = '+44123456789';
    const skills = ['personal_care', 'domestic_support', 'social_support'];
    const preferredShifts = ['morning', 'afternoon'];

    for (const home of supportedLivingHomes) {
      console.log(`📍 Processing ${home.name} (${home.location.city})`);
      console.log('-'.repeat(60));

      // Get current staff for this home
      const currentStaff = await User.find({
        'homes.home_id': home._id,
        is_active: true
      });

      const currentCounts = {
        fulltime: currentStaff.filter(u => u.type === 'fulltime').length,
        parttime: currentStaff.filter(u => u.type === 'parttime').length,
        bank: currentStaff.filter(u => u.type === 'bank').length,
        senior: currentStaff.filter(u => u.role === 'senior_staff').length
      };

      console.log(`   Current Staffing:`);
      console.log(`      🟢 Full Time: ${currentCounts.fulltime}/${SUPPORTED_LIVING_REQUIREMENTS.fulltime} (${currentCounts.senior}/1 senior)`);
      console.log(`      🟡 Part Time: ${currentCounts.parttime}/${SUPPORTED_LIVING_REQUIREMENTS.parttime}`);
      console.log(`      🔵 Bank: ${currentCounts.bank}/${SUPPORTED_LIVING_REQUIREMENTS.bank}`);

      // Calculate what's needed
      const needs = {
        fulltime: Math.max(0, SUPPORTED_LIVING_REQUIREMENTS.fulltime - currentCounts.fulltime),
        parttime: Math.max(0, SUPPORTED_LIVING_REQUIREMENTS.parttime - currentCounts.parttime),
        bank: Math.max(0, SUPPORTED_LIVING_REQUIREMENTS.bank - currentCounts.bank),
        senior: Math.max(0, 1 - currentCounts.senior)
      };

      if (needs.fulltime === 0 && needs.parttime === 0 && needs.bank === 0) {
        console.log(`   ✅ Staffing requirements already met!`);
        continue;
      }

      console.log(`   📋 Staffing Needs:`);
      if (needs.fulltime > 0) console.log(`      • ${needs.fulltime} full-time staff needed`);
      if (needs.parttime > 0) console.log(`      • ${needs.parttime} part-time staff needed`);
      if (needs.bank > 0) console.log(`      • ${needs.bank} bank staff needed`);
      if (needs.senior > 0) console.log(`      • ${needs.senior} senior staff needed`);

      // Create missing staff
      let createdCount = 0;

      // Create full-time staff first (including senior if needed)
      for (let i = 0; i < needs.fulltime; i++) {
        const isSenior = needs.senior > 0 && i === 0; // First full-time should be senior if needed
        const role = isSenior ? 'senior_staff' : 'support_worker';
        const staffNumber = currentCounts.fulltime + i + 1;
        
        const userData = {
          name: `${home.name.split(' ')[0]} Staff ${staffNumber}`,
          email: `${home.name.toLowerCase().replace(/\s+/g, '_')}_staff_${staffNumber}@rcs.com`,
          phone: commonPhone,
          password: commonPassword,
          role: role,
          type: 'fulltime',
          homes: [{ home_id: home._id, is_default: true }],
          default_home_id: home._id,
          is_active: true,
          skills: skills,
          preferred_shift_types: preferredShifts,
          min_hours_per_week: 40,
          max_hours_per_week: 40
        };

        try {
          const user = new User(userData);
          await user.save();
          createdCount++;
          
          const roleDisplay = isSenior ? 'Senior Staff' : 'Support Worker';
          console.log(`      ✅ Created: ${userData.name} (${roleDisplay}) - ${userData.email}`);
          
          if (isSenior) needs.senior--;
        } catch (error) {
          console.error(`      ❌ Failed to create ${userData.name}:`, error.message);
        }
      }

      // Create part-time staff
      for (let i = 0; i < needs.parttime; i++) {
        const staffNumber = currentCounts.parttime + i + 1;
        
        const userData = {
          name: `${home.name.split(' ')[0]} Part Time ${staffNumber}`,
          email: `${home.name.toLowerCase().replace(/\s+/g, '_')}_parttime_${staffNumber}@rcs.com`,
          phone: commonPhone,
          password: commonPassword,
          role: 'support_worker',
          type: 'parttime',
          homes: [{ home_id: home._id, is_default: true }],
          default_home_id: home._id,
          is_active: true,
          skills: skills,
          preferred_shift_types: preferredShifts,
          min_hours_per_week: 20,
          max_hours_per_week: 30
        };

        try {
          const user = new User(userData);
          await user.save();
          createdCount++;
          
          console.log(`      ✅ Created: ${userData.name} (Part Time) - ${userData.email}`);
        } catch (error) {
          console.error(`      ❌ Failed to create ${userData.name}:`, error.message);
        }
      }

      // Create bank staff
      for (let i = 0; i < needs.bank; i++) {
        const staffNumber = currentCounts.bank + i + 1;
        
        const userData = {
          name: `${home.name.split(' ')[0]} Bank ${staffNumber}`,
          email: `${home.name.toLowerCase().replace(/\s+/g, '_')}_bank_${staffNumber}@rcs.com`,
          phone: commonPhone,
          password: commonPassword,
          role: 'support_worker',
          type: 'bank',
          homes: [{ home_id: home._id, is_default: true }],
          default_home_id: home._id,
          is_active: true,
          skills: skills,
          preferred_shift_types: preferredShifts,
          min_hours_per_week: 0,
          max_hours_per_week: 20
        };

        try {
          const user = new User(userData);
          await user.save();
          createdCount++;
          
          console.log(`      ✅ Created: ${userData.name} (Bank) - ${userData.email}`);
        } catch (error) {
          console.error(`      ❌ Failed to create ${userData.name}:`, error.message);
        }
      }

      console.log(`   📊 Created ${createdCount} new staff members for ${home.name}\n`);
    }

    console.log('✅ Supported Living staff creation completed!');
    console.log('\n🔑 All new users have password: passWord123');
    console.log('📱 All new users have phone: +44123456789');

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
  createSupportedLivingStaff();
}

module.exports = { createSupportedLivingStaff };
