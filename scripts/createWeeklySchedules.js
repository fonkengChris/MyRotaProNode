const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

async function createWeeklySchedules() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    const WeeklySchedule = require('../models/WeeklySchedule');
    const Home = require('../models/Home');
    const Service = require('../models/Service');
    
    // Get all homes
    const homes = await Home.find({});
    console.log(`🏠 Found ${homes.length} homes in database`);
    
    if (homes.length === 0) {
      console.log('❌ No homes found - create homes first');
      return;
    }
    
    // Get a default service for the shifts
    const defaultService = await Service.findOne({});
    if (!defaultService) {
      console.log('❌ No services found - create services first');
      return;
    }
    console.log(`🔧 Using service: ${defaultService.name}`);
    
    // Create weekly schedules for each home
    for (const home of homes) {
      console.log(`\n🏠 Processing home: ${home.name}`);
      
      // Check if weekly schedule already exists
      const existingSchedule = await WeeklySchedule.findOne({ home_id: home._id });
      if (existingSchedule) {
        console.log(`   ⚠️  Weekly schedule already exists for ${home.name}, skipping...`);
        continue;
      }
      
      // Create weekly schedule based on home type/name
      let weeklySchedule;
      
      if (home.name.toLowerCase().includes('peace')) {
        // Peace Home: Two 12-hour shifts
        console.log(`   📅 Creating Peace Home schedule: 8:00-20:00 and 20:00-8:00`);
        weeklySchedule = createPeaceHomeSchedule(home._id, defaultService._id);
      } else if (home.name.toLowerCase().includes('hope')) {
        // Hope House: Three 8-hour shifts
        console.log(`   📅 Creating Hope House schedule: 7:00-15:00, 15:00-23:00, 23:00-7:00`);
        weeklySchedule = createHopeHouseSchedule(home._id, defaultService._id);
      } else {
        // Default: Standard three shifts
        console.log(`   📅 Creating default schedule: 7:00-15:00, 15:00-23:00, 23:00-7:00`);
        weeklySchedule = createDefaultSchedule(home._id, defaultService._id);
      }
      
      // Save the weekly schedule
      try {
        const savedSchedule = await WeeklySchedule.create(weeklySchedule);
        console.log(`   ✅ Created weekly schedule for ${home.name} (ID: ${savedSchedule._id})`);
      } catch (error) {
        console.error(`   ❌ Error creating weekly schedule for ${home.name}:`, error.message);
      }
    }
    
    // Verify the schedules were created
    const totalSchedules = await WeeklySchedule.countDocuments();
    console.log(`\n📊 Total weekly schedules created: ${totalSchedules}`);
    
  } catch (error) {
    console.error('❌ Script failed:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    mongoose.connection.close();
  }
}

// Create Peace Home schedule: Two 12-hour shifts
function createPeaceHomeSchedule(homeId, serviceId) {
  const baseSchedule = {
    monday: { is_active: true, shifts: [] },
    tuesday: { is_active: true, shifts: [] },
    wednesday: { is_active: true, shifts: [] },
    thursday: { is_active: true, shifts: [] },
    friday: { is_active: true, shifts: [] },
    saturday: { is_active: true, shifts: [] },
    sunday: { is_active: true, shifts: [] }
  };
  
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  days.forEach(day => {
    baseSchedule[day].shifts = [
      {
        service_id: serviceId,
        start_time: '08:00',
        end_time: '20:00',
        shift_type: 'long_day',
        required_staff_count: 2,
        notes: 'Day shift - 12 hours'
      },
      {
        service_id: serviceId,
        start_time: '20:00',
        end_time: '08:00',
        shift_type: 'night',
        required_staff_count: 1,
        notes: 'Night shift - 12 hours (overnight)'
      }
    ];
  });
  
  return {
    home_id: homeId,
    schedule: baseSchedule
  };
}

// Create Hope House schedule: Three 8-hour shifts
function createHopeHouseSchedule(homeId, serviceId) {
  const baseSchedule = {
    monday: { is_active: true, shifts: [] },
    tuesday: { is_active: true, shifts: [] },
    wednesday: { is_active: true, shifts: [] },
    thursday: { is_active: true, shifts: [] },
    friday: { is_active: true, shifts: [] },
    saturday: { is_active: true, shifts: [] },
    sunday: { is_active: true, shifts: [] }
  };
  
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  days.forEach(day => {
    baseSchedule[day].shifts = [
      {
        service_id: serviceId,
        start_time: '07:00',
        end_time: '15:00',
        shift_type: 'morning',
        required_staff_count: 2,
        notes: 'Morning shift - 8 hours'
      },
      {
        service_id: serviceId,
        start_time: '15:00',
        end_time: '23:00',
        shift_type: 'afternoon',
        required_staff_count: 2,
        notes: 'Afternoon shift - 8 hours'
      },
      {
        service_id: serviceId,
        start_time: '23:00',
        end_time: '07:00',
        shift_type: 'night',
        required_staff_count: 1,
        notes: 'Night shift - 8 hours (overnight)'
      }
    ];
  });
  
  return {
    home_id: homeId,
    schedule: baseSchedule
  };
}

// Create default schedule: Three 8-hour shifts
function createDefaultSchedule(homeId, serviceId) {
  const baseSchedule = {
    monday: { is_active: true, shifts: [] },
    tuesday: { is_active: true, shifts: [] },
    wednesday: { is_active: true, shifts: [] },
    thursday: { is_active: true, shifts: [] },
    friday: { is_active: true, shifts: [] },
    saturday: { is_active: true, shifts: [] },
    sunday: { is_active: true, shifts: [] }
  };
  
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  days.forEach(day => {
    baseSchedule[day].shifts = [
      {
        service_id: serviceId,
        start_time: '07:00',
        end_time: '15:00',
        shift_type: 'morning',
        required_staff_count: 2,
        notes: 'Morning shift - 8 hours'
      },
      {
        service_id: serviceId,
        start_time: '15:00',
        end_time: '23:00',
        shift_type: 'afternoon',
        required_staff_count: 2,
        notes: 'Afternoon shift - 8 hours'
      },
      {
        service_id: serviceId,
        start_time: '23:00',
        end_time: '07:00',
        shift_type: 'night',
        required_staff_count: 1,
        notes: 'Night shift - 8 hours (overnight)'
      }
    ];
  });
  
  return {
    home_id: homeId,
    schedule: baseSchedule
  };
}

// Run the script
createWeeklySchedules();
