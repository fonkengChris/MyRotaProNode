const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

async function checkWeeklySchedules() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    const WeeklySchedule = require('../models/WeeklySchedule');
    const Home = require('../models/Home');
    
    // Check what weekly schedules exist
    const weeklySchedules = await WeeklySchedule.find({});
    console.log(`📊 Found ${weeklySchedules.length} weekly schedules in database`);
    
    if (weeklySchedules.length === 0) {
      console.log('❌ No weekly schedules found - this is why AI solver uses default shifts');
      console.log('💡 You need to create weekly schedules for each home first');
      return;
    }
    
    // Display each weekly schedule
    for (const schedule of weeklySchedules) {
      console.log(`\n🏠 Weekly Schedule for Home ID: ${schedule.home_id}`);
      
      // Get home name
      const home = await Home.findById(schedule.home_id);
      if (home) {
        console.log(`   Home Name: ${home.name}`);
      }
      
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      
      days.forEach(day => {
        const daySchedule = schedule.schedule[day];
        if (daySchedule && daySchedule.is_active && daySchedule.shifts && daySchedule.shifts.length > 0) {
          console.log(`   ${day.charAt(0).toUpperCase() + day.slice(1)}: ${daySchedule.shifts.length} shifts`);
          daySchedule.shifts.forEach((shift, index) => {
            console.log(`     Shift ${index + 1}: ${shift.start_time} - ${shift.end_time} (${shift.shift_type}) - ${shift.required_staff_count} staff`);
          });
        } else {
          console.log(`   ${day.charAt(0).toUpperCase() + day.slice(1)}: No active shifts`);
        }
      });
    }
    
  } catch (error) {
    console.error('❌ Script failed:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    mongoose.connection.close();
  }
}

// Run the script
checkWeeklySchedules();
