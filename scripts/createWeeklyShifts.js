const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const Service = require('../models/Service');
require('dotenv').config({ path: '../env.example' });

/**
 * Script to automatically create shifts for a week in all homes offering Supported Living service
 * Creates long day (08:00-20:00) and night (20:00-08:00) shifts
 * for the week of September 1-7, 2025
 */

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
  '2025-09-01', // Monday
  '2025-09-02', // Tuesday
  '2025-09-03', // Wednesday
  '2025-09-04', // Thursday
  '2025-09-05', // Friday
  '2025-09-06', // Saturday
  '2025-09-07'  // Sunday
];

async function createWeeklyShifts() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    // Find all homes with Supported Living service
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

    let totalCreatedShifts = 0;
    let totalErrors = 0;

    // Process each Supported Living home
    for (const home of supportedLivingHomes) {
      console.log(`📍 Processing ${home.name} (${home.location.city})`);
      console.log('=' .repeat(60));

      // Find or create a default service for this home
      let service = await Service.findOne({ 
        home_ids: home._id,
        is_active: true 
      });

      if (!service) {
        console.log('🔧 No active service found for this home. Creating a default service...');
        
        service = new Service({
          name: 'Supported Living Service',
          description: `Default Supported Living service for ${home.name}`,
          home_ids: [home._id],
          category: 'social',
          required_skills: ['personal_care', 'domestic_support', 'social_support'],
          min_staff_count: 1,
          max_staff_count: 3,
          duration_hours: 12,
          is_24_hour: true,
          priority_level: 'high',
          is_active: true
        });
        
        await service.save();
        console.log(`✅ Created default service: ${service.name} (ID: ${service._id})`);
      } else {
        console.log(`✅ Found service: ${service.name} (ID: ${service._id})`);
      }

      // Check for existing shifts in the week
      const existingShifts = await Shift.find({
        home_id: home._id,
        date: { $in: WEEK_DATES }
      });

      if (existingShifts.length > 0) {
        console.log(`⚠️  Found ${existingShifts.length} existing shifts for this week`);
        console.log('💡 Existing shifts:');
        existingShifts.forEach(shift => {
          console.log(`   - ${shift.date} ${shift.start_time}-${shift.end_time} (${shift.shift_type})`);
        });
        
        const response = await askUserConfirmation(`Do you want to continue and create additional shifts for ${home.name}? (y/N): `);
        if (response.toLowerCase() !== 'y' && response.toLowerCase() !== 'yes') {
          console.log(`⏭️  Skipping ${home.name}`);
          continue;
        }
      }

      // Create shifts for each day
      console.log(`\n🔧 Creating weekly shifts for ${home.name}...`);
      const createdShifts = [];
      const errors = [];

      for (const date of WEEK_DATES) {
        console.log(`\n📅 Processing ${date} (${getDayName(date)})`);
        
        // Create long day shift
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
          console.log(`   ✅ Long day shift: ${SHIFT_CONFIG.long_day.start_time}-${SHIFT_CONFIG.long_day.end_time}`);
        } catch (error) {
          console.error(`   ❌ Failed to create long day shift: ${error.message}`);
          errors.push({ date, shift_type: 'long_day', error: error.message });
        }

        // Create night shift
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
          console.log(`   ✅ Night shift: ${SHIFT_CONFIG.night.start_time}-${SHIFT_CONFIG.night.end_time}`);
        } catch (error) {
          console.error(`   ❌ Failed to create night shift: ${error.message}`);
          errors.push({ date, shift_type: 'night', error: error.message });
        }
      }

      // Summary for this home
      console.log(`\n📊 ${home.name} Summary:`);
      console.log(`✅ Successfully created: ${createdShifts.length} shifts`);
      console.log(`❌ Failed to create: ${errors.length} shifts`);
      
      if (createdShifts.length > 0) {
        console.log(`\n📋 Created Shifts for ${home.name}:`);
        const shiftsByDate = groupShiftsByDate(createdShifts);
        Object.keys(shiftsByDate).sort().forEach(date => {
          console.log(`\n   ${date} (${getDayName(date)}):`);
          shiftsByDate[date].forEach(shift => {
            console.log(`     - ${shift.start_time}-${shift.end_time} (${shift.shift_type}) - ${shift.required_staff_count} staff`);
          });
        });

        // Calculate total hours for this home
        const totalHours = createdShifts.reduce((total, shift) => {
          const start = new Date(`2000-01-01T${shift.start_time}`);
          let end = new Date(`2000-01-01T${shift.end_time}`);
          
          // Handle overnight shifts
          if (end < start) {
            end.setDate(end.getDate() + 1);
          }
          
          const diffMs = end.getTime() - start.getTime();
          const diffHours = diffMs / (1000 * 60 * 60);
          return total + diffHours;
        }, 0);

        console.log(`\n⏰ Total hours for ${home.name}: ${totalHours.toFixed(1)} hours`);
        console.log(`👥 Total staff positions for ${home.name}: ${createdShifts.reduce((sum, shift) => sum + shift.required_staff_count, 0)}`);
      }

      if (errors.length > 0) {
        console.log(`\n❌ Errors for ${home.name}:`);
        errors.forEach(error => {
          console.log(`   - ${error.date} ${error.shift_type}: ${error.error}`);
        });
      }

      totalCreatedShifts += createdShifts.length;
      totalErrors += errors.length;

      console.log(`\n✅ Completed shifts for ${home.name}\n`);
    }

    // Overall summary
    console.log('=' .repeat(80));
    console.log('📊 OVERALL SUMMARY');
    console.log('=' .repeat(80));
    console.log(`🏠 Total Homes Processed: ${supportedLivingHomes.length}`);
    console.log(`✅ Total Shifts Created: ${totalCreatedShifts}`);
    console.log(`❌ Total Errors: ${totalErrors}`);
    
    // Calculate total hours across all homes
    const totalHours = (totalCreatedShifts * 12); // Each shift is 12 hours
    const totalStaffPositions = totalCreatedShifts * 1.5; // Average staff per shift
    
    console.log(`\n⏰ Total hours across all homes: ${totalHours.toFixed(1)} hours`);
    console.log(`👥 Total staff positions across all homes: ${totalStaffPositions.toFixed(0)}`);

    console.log('\n✅ Weekly shift creation completed for all Supported Living homes!');
    console.log('💡 You can now assign staff to these shifts through the rota editor');

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

// Helper function to ask for user confirmation (for CLI)
async function askUserConfirmation(question) {
  // In a real CLI environment, you would use readline or similar
  // For now, we'll return 'N' to avoid blocking
  console.log(question + ' N (auto-continuing)');
  return 'N';
}

// Run the script if this script is executed directly
if (require.main === module) {
  createWeeklyShifts();
}

module.exports = { createWeeklyShifts };
