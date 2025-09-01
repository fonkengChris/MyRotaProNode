const mongoose = require('mongoose');
const User = require('../models/User');
const Home = require('../models/Home');
require('dotenv').config({ path: '../env.example' });

async function analyzeHomeStaffing() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB\n');

    // Get all homes
    const homes = await Home.find({ is_active: true }).sort({ name: 1 });
    
    if (homes.length === 0) {
      console.log('❌ No active homes found in the system');
      return;
    }

    console.log('🏠 HOME STAFFING ANALYSIS\n');
    console.log('=' .repeat(80));

    let totalUsers = 0;
    let totalByType = {
      fulltime: 0,
      parttime: 0,
      bank: 0
    };

    // Analyze each home
    for (const home of homes) {
      console.log(`\n📍 HOME: ${home.name}`);
      console.log(`   Location: ${home.location.city}, ${home.location.postcode}`);
      console.log(`   Manager: ${home.manager_id?.name || 'Not assigned'}`);
      console.log('-'.repeat(60));

      // Find users assigned to this home
      const users = await User.find({
        'homes.home_id': home._id,
        is_active: true
      }).sort({ name: 1 });

      if (users.length === 0) {
        console.log('   ❌ No staff assigned to this home');
        continue;
      }

      // Count users by type
      const usersByType = {
        fulltime: [],
        parttime: [],
        bank: []
      };

      users.forEach(user => {
        usersByType[user.type].push(user);
        totalByType[user.type]++;
      });

      totalUsers += users.length;

      // Display user counts by type
      console.log(`   👥 Total Staff: ${users.length}`);
      console.log(`   📊 Breakdown by Type:`);
      
      if (usersByType.fulltime.length > 0) {
        console.log(`      🟢 Full Time: ${usersByType.fulltime.length}`);
        usersByType.fulltime.forEach(user => {
          console.log(`         - ${user.name} (${user.role})`);
        });
      }

      if (usersByType.parttime.length > 0) {
        console.log(`      🟡 Part Time: ${usersByType.parttime.length}`);
        usersByType.parttime.forEach(user => {
          console.log(`         - ${user.name} (${user.role})`);
        });
      }

      if (usersByType.bank.length > 0) {
        console.log(`      🔵 Bank: ${usersByType.bank.length}`);
        usersByType.bank.forEach(user => {
          console.log(`         - ${user.name} (${user.role})`);
        });
      }

      // Calculate percentages
      const fulltimePercent = ((usersByType.fulltime.length / users.length) * 100).toFixed(1);
      const parttimePercent = ((usersByType.parttime.length / users.length) * 100).toFixed(1);
      const bankPercent = ((usersByType.bank.length / users.length) * 100).toFixed(1);

      console.log(`   📈 Percentages:`);
      console.log(`      Full Time: ${fulltimePercent}%`);
      console.log(`      Part Time: ${parttimePercent}%`);
      console.log(`      Bank: ${bankPercent}%`);

      // Role distribution
      const roleCounts = {};
      users.forEach(user => {
        roleCounts[user.role] = (roleCounts[user.role] || 0) + 1;
      });

      console.log(`   🎭 Role Distribution:`);
      Object.entries(roleCounts).forEach(([role, count]) => {
        const roleDisplay = role.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
        console.log(`      ${roleDisplay}: ${count}`);
      });
    }

    // Overall summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 OVERALL SUMMARY');
    console.log('='.repeat(80));
    
    console.log(`\n🏢 Total Active Homes: ${homes.length}`);
    console.log(`👥 Total Active Staff: ${totalUsers}`);
    console.log(`\n📊 Total Staff by Type:`);
    console.log(`   🟢 Full Time: ${totalByType.fulltime} (${((totalByType.fulltime / totalUsers) * 100).toFixed(1)}%)`);
    console.log(`   🟡 Part Time: ${totalByType.parttime} (${((totalByType.parttime / totalUsers) * 100).toFixed(1)}%)`);
    console.log(`   🔵 Bank: ${totalByType.bank} (${((totalByType.bank / totalUsers) * 100).toFixed(1)}%)`);

    // Find homes with staffing issues
    console.log(`\n⚠️  STAFFING ANALYSIS:`);
    
    // Get all users for analysis
    const allUsers = await User.find({ is_active: true });
    
    homes.forEach(home => {
      const homeUsers = allUsers.filter(u => u.homes.some(h => h.home_id.toString() === home._id.toString()));
      const fulltimeCount = homeUsers.filter(u => u.type === 'fulltime').length;
      const parttimeCount = homeUsers.filter(u => u.type === 'parttime').length;
      const bankCount = homeUsers.filter(u => u.type === 'bank').length;
      
      if (homeUsers.length === 0) {
        console.log(`   ❌ ${home.name}: No staff assigned`);
      } else if (fulltimeCount === 0) {
        console.log(`   ⚠️  ${home.name}: No full-time staff (${parttimeCount} part-time, ${bankCount} bank)`);
      } else if (fulltimeCount < 2) {
        console.log(`   ⚠️  ${home.name}: Low full-time staff (${fulltimeCount} full-time, ${parttimeCount} part-time, ${bankCount} bank)`);
      } else if (bankCount === 0) {
        console.log(`   ℹ️  ${home.name}: No bank staff (${fulltimeCount} full-time, ${parttimeCount} part-time)`);
      }
    });

    // Recommendations
    console.log(`\n💡 RECOMMENDATIONS:`);
    
    if (totalByType.bank === 0) {
      console.log(`   • Consider adding bank staff for flexibility and coverage`);
    }
    
    if (totalByType.parttime < totalByType.fulltime * 0.3) {
      console.log(`   • Part-time staff ratio is low - consider adding more part-time positions`);
    }
    
    if (totalByType.fulltime < totalByType.parttime) {
      console.log(`   • Full-time staff ratio is low - consider converting some part-time to full-time`);
    }

    console.log(`\n✅ Analysis complete!`);

  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Function to generate a CSV report
async function generateCSVReport() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB\n');

    const homes = await Home.find({ is_active: true }).sort({ name: 1 });
    const users = await User.find({ is_active: true });

    console.log('📊 Generating CSV Report...\n');

    // CSV Header
    let csv = 'Home,Location,Manager,Total Staff,Full Time,Part Time,Bank,Admin,Home Manager,Senior Staff,Support Worker\n';

    for (const home of homes) {
      const homeUsers = users.filter(u => 
        u.homes.some(h => h.home_id.toString() === home._id.toString())
      );

      const counts = {
        total: homeUsers.length,
        fulltime: homeUsers.filter(u => u.type === 'fulltime').length,
        parttime: homeUsers.filter(u => u.type === 'parttime').length,
        bank: homeUsers.filter(u => u.type === 'bank').length,
        admin: homeUsers.filter(u => u.role === 'admin').length,
        home_manager: homeUsers.filter(u => u.role === 'home_manager').length,
        senior_staff: homeUsers.filter(u => u.role === 'senior_staff').length,
        support_worker: homeUsers.filter(u => u.role === 'support_worker').length
      };

      const managerName = home.manager_id?.name || 'Not assigned';
      
      csv += `"${home.name}","${home.location.city}","${managerName}",${counts.total},${counts.fulltime},${counts.parttime},${counts.bank},${counts.admin},${counts.home_manager},${counts.senior_staff},${counts.support_worker}\n`;
    }

    // Write to file
    const fs = require('fs');
    const filename = `home_staffing_report_${new Date().toISOString().split('T')[0]}.csv`;
    fs.writeFileSync(filename, csv);
    
    console.log(`✅ CSV report generated: ${filename}`);
    console.log(`📁 File saved in: ${process.cwd()}`);

  } catch (error) {
    console.error('❌ CSV generation failed:', error);
  } finally {
    await mongoose.connection.close();
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--csv') || args.includes('-c')) {
    generateCSVReport();
  } else {
    analyzeHomeStaffing();
  }
}

module.exports = { analyzeHomeStaffing, generateCSVReport };
