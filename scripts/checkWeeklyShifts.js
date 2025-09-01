const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const Home = require('../models/Home');
require('dotenv').config({ path: '../env.example' });

async function checkWeeklyShifts() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB\n');
    
    // Week dates to check
    const weekDates = [
      '2025-09-01', '2025-09-02', '2025-09-03', '2025-09-04', 
      '2025-09-05', '2025-09-06', '2025-09-07'
    ];
    
    // Get all Supported Living homes
    const supportedLivingHomes = await Home.find({
      name: { $in: ['Gentle House', 'Happy House', 'Hope House', 'Love House', 'Peace Home'] }
    }).sort({ name: 1 });
    
    console.log('📊 WEEKLY SHIFTS CREATED FOR SUPPORTED LIVING HOMES');
    console.log('=' .repeat(80));
    console.log(`📅 Week: September 1-7, 2025`);
    console.log(`🏠 Homes: ${supportedLivingHomes.length}\n`);
    
    let totalShifts = 0;
    let totalHours = 0;
    let totalStaffPositions = 0;
    
    for (const home of supportedLivingHomes) {
      const shifts = await Shift.find({ 
        home_id: home._id,
        date: { $in: weekDates }
      }).sort({ date: 1, start_time: 1 });
      
      console.log(`📍 ${home.name} (${home.location.city})`);
      console.log(`   Total Shifts: ${shifts.length}`);
      
      if (shifts.length > 0) {
        // Group shifts by date
        const shiftsByDate = {};
        shifts.forEach(shift => {
          if (!shiftsByDate[shift.date]) {
            shiftsByDate[shift.date] = [];
          }
          shiftsByDate[shift.date].push(shift);
        });
        
        // Display shifts by date
        Object.keys(shiftsByDate).sort().forEach(date => {
          const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'short' });
          console.log(`   ${date} (${dayName}):`);
          shiftsByDate[date].forEach(shift => {
            console.log(`     • ${shift.start_time}-${shift.end_time} (${shift.shift_type}) - ${shift.required_staff_count} staff`);
          });
        });
        
        // Calculate metrics for this home
        const homeHours = shifts.length * 12; // Each shift is 12 hours
        const homeStaffPositions = shifts.reduce((sum, shift) => sum + shift.required_staff_count, 0);
        
        console.log(`   ⏰ Total Hours: ${homeHours} hours`);
        console.log(`   👥 Total Staff Positions: ${homeStaffPositions}`);
        
        totalShifts += shifts.length;
        totalHours += homeHours;
        totalStaffPositions += homeStaffPositions;
      } else {
        console.log('   ❌ No shifts found for this week');
      }
      
      console.log('');
    }
    
    // Overall summary
    console.log('=' .repeat(80));
    console.log('📊 OVERALL SUMMARY');
    console.log('=' .repeat(80));
    console.log(`🏠 Supported Living Homes: ${supportedLivingHomes.length}`);
    console.log(`📅 Week: September 1-7, 2025`);
    console.log(`✅ Total Shifts Created: ${totalShifts}`);
    console.log(`⏰ Total Hours: ${totalHours} hours`);
    console.log(`👥 Total Staff Positions: ${totalStaffPositions}`);
    
    // Expected vs actual
    const expectedShifts = supportedLivingHomes.length * 14; // 2 shifts per day * 7 days
    const expectedHours = expectedShifts * 12;
    const expectedStaffPositions = expectedShifts * 1.5; // Average staff per shift
    
    console.log(`\n📋 EXPECTED vs ACTUAL:`);
    console.log(`   Expected Shifts: ${expectedShifts}`);
    console.log(`   Actual Shifts: ${totalShifts}`);
    console.log(`   Expected Hours: ${expectedHours}`);
    console.log(`   Actual Hours: ${totalHours}`);
    console.log(`   Expected Staff Positions: ${expectedStaffPositions.toFixed(0)}`);
    console.log(`   Actual Staff Positions: ${totalStaffPositions}`);
    
    if (totalShifts === expectedShifts) {
      console.log(`\n✅ All expected shifts have been created successfully!`);
    } else {
      console.log(`\n⚠️  Some shifts may be missing. Expected: ${expectedShifts}, Actual: ${totalShifts}`);
    }
    
    console.log('\n✅ Shift verification completed!');

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
  checkWeeklyShifts();
}

module.exports = { checkWeeklyShifts };
