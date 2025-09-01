const mongoose = require('mongoose');
const Service = require('../models/Service');
const Home = require('../models/Home');
const User = require('../models/User');
require('dotenv').config({ path: '../env.example' });

async function checkServicesAndHomes() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB\n');

    // Get all homes and services
    const homes = await Home.find({ is_active: true }).sort({ name: 1 });
    const services = await Service.find({ is_active: true }).sort({ name: 1 });
    const users = await User.find({ is_active: true });

    console.log('🏠 HOMES AND THEIR SERVICES:');
    console.log('=' .repeat(80));

    let supportedLivingHomes = [];

    homes.forEach(home => {
      console.log(`\n📍 ${home.name} (${home.location.city})`);
      
      // Find services for this home
      const homeServices = services.filter(service => 
        service.home_ids.some(homeId => homeId.toString() === home._id.toString())
      );

      if (homeServices.length > 0) {
        homeServices.forEach(service => {
          console.log(`   • ${service.name} - ${service.description}`);
          console.log(`     Category: ${service.category}, Duration: ${service.duration_hours}h`);
          console.log(`     Staff Required: ${service.min_staff_count}-${service.max_staff_count}`);
          
          // Check if this is Supported Living service
          if (service.name.toLowerCase().includes('supported living') || 
              service.description.toLowerCase().includes('supported living')) {
            supportedLivingHomes.push(home);
            console.log(`     🏠 SUPPORTED LIVING SERVICE IDENTIFIED`);
          }
        });
      } else {
        console.log('   ❌ No services configured');
      }

      // Show current staffing
      const homeStaff = users.filter(user => 
        user.homes.some(userHome => userHome.home_id.toString() === home._id.toString())
      );

      if (homeStaff.length > 0) {
        const fulltimeCount = homeStaff.filter(u => u.type === 'fulltime').length;
        const parttimeCount = homeStaff.filter(u => u.type === 'parttime').length;
        const bankCount = homeStaff.filter(u => u.type === 'bank').length;
        const seniorCount = homeStaff.filter(u => u.role === 'senior_staff').length;
        
        console.log(`   👥 Current Staffing: ${homeStaff.length} total`);
        console.log(`      🟢 Full Time: ${fulltimeCount} (${seniorCount} senior)`);
        console.log(`      🟡 Part Time: ${parttimeCount}`);
        console.log(`      🔵 Bank: ${bankCount}`);
      } else {
        console.log('   👥 Current Staffing: No staff assigned');
      }
    });

    console.log('\n' + '='.repeat(80));
    console.log('📊 SUPPORTED LIVING HOMES ANALYSIS');
    console.log('='.repeat(80));

    if (supportedLivingHomes.length > 0) {
      console.log(`\n🏠 Found ${supportedLivingHomes.length} home(s) with Supported Living service:`);
      
      supportedLivingHomes.forEach(home => {
        console.log(`\n📍 ${home.name} (${home.location.city})`);
        
        // Get current staffing for this home
        const homeStaff = users.filter(user => 
          user.homes.some(userHome => userHome.home_id.toString() === home._id.toString())
        );

        const fulltimeCount = homeStaff.filter(u => u.type === 'fulltime').length;
        const parttimeCount = homeStaff.filter(u => u.type === 'parttime').length;
        const bankCount = homeStaff.filter(u => u.type === 'bank').length;
        const seniorCount = homeStaff.filter(u => u.role === 'senior_staff').length;

        console.log(`   Current Staffing:`);
        console.log(`      🟢 Full Time: ${fulltimeCount}/3 (${seniorCount}/1 senior)`);
        console.log(`      🟡 Part Time: ${parttimeCount}/2`);
        console.log(`      🔵 Bank: ${bankCount}/2`);

        // Calculate what's needed
        const fulltimeNeeded = Math.max(0, 3 - fulltimeCount);
        const parttimeNeeded = Math.max(0, 2 - parttimeCount);
        const bankNeeded = Math.max(0, 2 - bankCount);
        const seniorNeeded = Math.max(0, 1 - seniorCount);

        if (fulltimeNeeded > 0 || parttimeNeeded > 0 || bankNeeded > 0) {
          console.log(`   📋 Staffing Needs:`);
          if (fulltimeNeeded > 0) {
            console.log(`      • ${fulltimeNeeded} full-time staff needed`);
            if (seniorNeeded > 0) {
              console.log(`        (${seniorNeeded} should be senior staff)`);
            }
          }
          if (parttimeNeeded > 0) console.log(`      • ${parttimeNeeded} part-time staff needed`);
          if (bankNeeded > 0) console.log(`      • ${bankNeeded} bank staff needed`);
        } else {
          console.log(`   ✅ Staffing requirements met!`);
        }
      });
    } else {
      console.log('\n❌ No homes with Supported Living service found.');
      console.log('💡 You may need to create Supported Living services for the appropriate homes.');
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 OVERALL SUMMARY');
    console.log('='.repeat(80));
    
    console.log(`\n🏢 Total Active Homes: ${homes.length}`);
    console.log(`🔧 Total Active Services: ${services.length}`);
    console.log(`👥 Total Active Staff: ${users.length}`);
    console.log(`🏠 Homes with Supported Living: ${supportedLivingHomes.length}`);

    // Show service categories
    const serviceCategories = [...new Set(services.map(s => s.category))];
    console.log(`\n📋 Service Categories Available:`);
    serviceCategories.forEach(category => {
      const categoryServices = services.filter(s => s.category === category);
      console.log(`   • ${category}: ${categoryServices.length} services`);
    });

    console.log('\n✅ Analysis complete!');

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
  checkServicesAndHomes();
}

module.exports = { checkServicesAndHomes };
