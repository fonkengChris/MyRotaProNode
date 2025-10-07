const mongoose = require('mongoose');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');

// Production MongoDB URI
const PRODUCTION_MONGODB_URI = 'mongodb+srv://chrisfonkeng:chrisfonkeng123@cluster0.8qj8x.mongodb.net/myrotapro?retryWrites=true&w=majority';

async function verifySeededUsers() {
  try {
    console.log('🔍 Verifying seeded users...\n');
    
    // Connect to production database
    await mongoose.connect(PRODUCTION_MONGODB_URI);
    console.log('✅ Connected to production database');

    // Get all data
    const homes = await Home.find({ is_active: true });
    const services = await Service.find({ is_active: true });
    const users = await User.find({ is_active: true });

    console.log(`📊 Database Statistics:`);
    console.log(`  🏠 Active Homes: ${homes.length}`);
    console.log(`  🔧 Active Services: ${services.length}`);
    console.log(`  👥 Active Users: ${users.length}`);

    // Analyze users by role
    const usersByRole = {};
    const usersByType = {};
    const usersByEmailDomain = {};
    const usersWithMultipleHomes = [];

    users.forEach(user => {
      // Count by role
      usersByRole[user.role] = (usersByRole[user.role] || 0) + 1;
      
      // Count by employment type
      usersByType[user.type] = (usersByType[user.type] || 0) + 1;
      
      // Check email domain
      const domain = user.email.split('@')[1];
      usersByEmailDomain[domain] = (usersByEmailDomain[domain] || 0) + 1;
      
      // Check for multiple homes
      if (user.homes && user.homes.length > 1) {
        usersWithMultipleHomes.push({
          name: user.name,
          email: user.email,
          homes: user.homes.length,
          role: user.role
        });
      }
    });

    console.log('\n📈 Users by Role:');
    Object.entries(usersByRole).forEach(([role, count]) => {
      console.log(`  ${role}: ${count}`);
    });

    console.log('\n📈 Users by Employment Type:');
    Object.entries(usersByType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    console.log('\n📧 Email Domains:');
    Object.entries(usersByEmailDomain).forEach(([domain, count]) => {
      console.log(`  ${domain}: ${count}`);
    });

    // Analyze users per home
    console.log('\n🏠 Users per Home:');
    const usersPerHome = {};
    
    homes.forEach(home => {
      const homeUsers = users.filter(user => 
        user.homes.some(userHome => userHome.home_id.toString() === home._id.toString())
      );
      usersPerHome[home.name] = homeUsers.length;
    });

    Object.entries(usersPerHome).forEach(([homeName, userCount]) => {
      console.log(`  ${homeName}: ${userCount} users`);
    });

    // Check for outreach services
    console.log('\n🔍 Outreach Services Analysis:');
    const outreachHomes = [];
    
    homes.forEach(home => {
      const homeServices = services.filter(service => 
        service.home_ids.some(homeId => homeId.toString() === home._id.toString())
      );
      
      const hasOutreach = homeServices.some(service => 
        service.name.toLowerCase().includes('outreach') || 
        service.name.toLowerCase().includes('community')
      );
      
      if (hasOutreach) {
        const homeUsers = users.filter(user => 
          user.homes.some(userHome => userHome.home_id.toString() === home._id.toString())
        );
        outreachHomes.push({
          name: home.name,
          userCount: homeUsers.length,
          hasSeniorStaff: homeUsers.some(user => user.role === 'senior_staff')
        });
      }
    });

    outreachHomes.forEach(home => {
      console.log(`  ${home.name}: ${home.userCount} users, Senior Staff: ${home.hasSeniorStaff ? 'Yes' : 'No'}`);
    });

    // Cross-home workers
    console.log('\n🔄 Cross-Home Workers:');
    if (usersWithMultipleHomes.length > 0) {
      usersWithMultipleHomes.forEach(user => {
        console.log(`  ${user.name} (${user.email}): ${user.homes} homes, Role: ${user.role}`);
      });
    } else {
      console.log('  No cross-home workers found');
    }

    // Password verification (test a few users)
    console.log('\n🔐 Password Verification:');
    const testUsers = users.slice(0, 3);
    for (const user of testUsers) {
      const isPasswordValid = await user.comparePassword('passWord123#');
      console.log(`  ${user.email}: ${isPasswordValid ? '✅ Valid' : '❌ Invalid'}`);
    }

    // Summary
    console.log('\n📊 VERIFICATION SUMMARY:');
    console.log(`✅ Total users created: ${users.length}`);
    console.log(`✅ Users with @myrotapro.com emails: ${usersByEmailDomain['myrotapro.com'] || 0}`);
    console.log(`✅ Cross-home workers: ${usersWithMultipleHomes.length}`);
    console.log(`✅ Outreach homes: ${outreachHomes.length}`);
    
    const expectedUsersPerRegularHome = 8; // 4 fulltime + 2 parttime + 2 bank
    const regularHomes = homes.length - outreachHomes.length;
    const expectedRegularUsers = regularHomes * expectedUsersPerRegularHome;
    const expectedOutreachUsers = outreachHomes.length * 2; // 1-2 per outreach home
    const expectedTotal = expectedRegularUsers + expectedOutreachUsers + usersWithMultipleHomes.length;
    
    console.log(`📈 Expected users: ~${expectedTotal}`);
    console.log(`📈 Actual users: ${users.length}`);
    console.log(`📈 Difference: ${users.length - expectedTotal}`);

  } catch (error) {
    console.error('❌ Error verifying users:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
}

// Run verification if called directly
if (require.main === module) {
  verifySeededUsers();
}

module.exports = { verifySeededUsers };
