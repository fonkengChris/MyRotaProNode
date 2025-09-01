const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const Service = require('../models/Service');
require('dotenv').config({ path: '../env.example' });

// Shift configuration
const SHIFT_CONFIG = {
  long_day: {
    start_time: '08:00',
    end_time: '20:00',
    shift_type: 'long_day',
    required_staff_count: 2
  },
  night: {
    start_time: '20:00',
    end_time: '08:00',
    shift_type: 'night',
    required_staff_count: 1
  }
};

// Week dates (September 1-7, 2025)
const WEEK_DATES = [
  '2025-09-01', '2025-09-02', '2025-09-03', '2025-09-04', 
  '2025-09-05', '2025-09-06', '2025-09-07'
];

async function completeHopeHouseShifts() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    // Find Hope House
    const home = await Home.findOne({ name: 'Hope House' });
    if (!home) {
      console.log('❌ Hope House not found!');
      return;
    }
    console.log(`🏠 Found home: ${home.name} (ID: ${home._id})`);

    // Find the Supported Living service
    const service = await Service.findOne({ 
      home_ids: home._id,
      is_active: true 
    });

    if (!service) {
      console.log('❌ No active service found for Hope House');
      return;
    }
    console.log(`✅ Found service: ${service.name} (ID: ${service._id})`);

    // Check existing shifts
    const existingShifts = await Shift.find({
      home_id: home._id,
      date: { $in: WEEK_DATES }
    });

    console.log(`\n📊 Current shifts in Hope House:`);
    if (existingShifts.length > 0) {
      existingShifts.forEach(shift => {
        console.log(`   - ${shift.date} ${shift.start_time}-${shift.end_time} (${shift.shift_type})`);
      });
    } else {
      console.log('   ❌ No shifts found');
    }

    // Create missing shifts
    console.log('\n🔧 Creating missing weekly shifts for Hope House...');
    const createdShifts = [];
    const errors = [];

    for (const date of WEEK_DATES) {
      // Check if long day shift exists
      const existingLongDay = existingShifts.find(s => 
        s.date === date && s.shift_type === 'long_day'
      );

      if (!existingLongDay) {
        try {
          const longDayShift = new Shift({
            home_id: home._id,
            service_id: service._id,
            date: date,
            start_time: SHIFT_CONFIG.long_day.start_time,
            end_time: SHIFT_CONFIG.long_day.end_time,
            shift_type: SHIFT_CONFIG.long_day.shift_type,
            required_staff_count: SHIFT_CONFIG.long_day.required_staff_count,
            notes: `Automatically generated long day shift for ${home.name}`,
            is_active: true
          });
          
          await longDayShift.save();
          createdShifts.push(longDayShift);
          console.log(`   ✅ Created long day shift: ${date} ${SHIFT_CONFIG.long_day.start_time}-${SHIFT_CONFIG.long_day.end_time}`);
        } catch (error) {
          console.error(`   ❌ Failed to create long day shift for ${date}: ${error.message}`);
          errors.push({ date, shift_type: 'long_day', error: error.message });
        }
      } else {
        console.log(`   ⏭️  Long day shift already exists for ${date}`);
      }

      // Check if night shift exists
      const existingNight = existingShifts.find(s => 
        s.date === date && s.shift_type === 'night'
      );

      if (!existingNight) {
        try {
          const nightShift = new Shift({
            home_id: home._id,
            service_id: service._id,
            date: date,
            start_time: SHIFT_CONFIG.night.start_time,
            end_time: SHIFT_CONFIG.night.end_time,
            shift_type: SHIFT_CONFIG.night.shift_type,
            required_staff_count: SHIFT_CONFIG.night.required_staff_count,
            notes: `Automatically generated night shift for ${home.name}`,
            is_active: true
          });
          
          await nightShift.save();
          createdShifts.push(nightShift);
          console.log(`   ✅ Created night shift: ${date} ${SHIFT_CONFIG.night.start_time}-${SHIFT_CONFIG.night.end_time}`);
        } catch (error) {
          console.error(`   ❌ Failed to create night shift for ${date}: ${error.message}`);
          errors.push({ date, shift_type: 'night', error: error.message });
        }
      } else {
        console.log(`   ⏭️  Night shift already exists for ${date}`);
      }
    }

    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`✅ Successfully created: ${createdShifts.length} shifts`);
    console.log(`❌ Failed to create: ${errors.length} shifts`);
    
    if (createdShifts.length > 0) {
      console.log('\n📋 Newly Created Shifts:');
      const shiftsByDate = groupShiftsByDate(createdShifts);
      Object.keys(shiftsByDate).sort().forEach(date => {
        console.log(`\n   ${date} (${getDayName(date)}):`);
        shiftsByDate[date].forEach(shift => {
          console.log(`     - ${shift.start_time}-${shift.end_time} (${shift.shift_type}) - ${shift.required_staff_count} staff`);
        });
      });
    }

    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach(error => {
        console.log(`   - ${error.date} ${error.shift_type}: ${error.error}`);
      });
    }

    // Final verification
    const finalShifts = await Shift.find({
      home_id: home._id,
      date: { $in: WEEK_DATES }
    });

    console.log(`\n📊 Final Shift Count for Hope House: ${finalShifts.length}/14`);
    if (finalShifts.length === 14) {
      console.log('✅ Hope House now has complete weekly coverage!');
    } else {
      console.log(`⚠️  Hope House still missing ${14 - finalShifts.length} shifts`);
    }

    console.log('\n✅ Hope House shift completion finished!');

  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Helper function to get day name
function getDayName(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

// Helper function to group shifts by date
function groupShiftsByDate(shifts) {
  return shifts.reduce((groups, shift) => {
    const date = shift.date;
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(shift);
    return groups;
  }, {});
}

// Run the script
if (require.main === module) {
  completeHopeHouseShifts();
}

module.exports = { completeHopeHouseShifts };
