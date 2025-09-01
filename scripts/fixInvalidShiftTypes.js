const mongoose = require('mongoose');
const WeeklySchedule = require('../models/WeeklySchedule');

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/myrotapro')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

async function fixInvalidShiftTypes() {
  try {
    console.log('🔍 Searching for weekly schedules with invalid shift types...');
    
    const schedules = await WeeklySchedule.find({});
    console.log(`📊 Found ${schedules.length} weekly schedules`);
    
    let fixedCount = 0;
    
    for (const schedule of schedules) {
      let needsUpdate = false;
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      
      for (const day of days) {
        if (schedule.schedule[day] && schedule.schedule[day].shifts) {
          for (const shift of schedule.schedule[day].shifts) {
            // Check if shift_type is invalid
            if (shift.shift_type === 'day') {
              console.log(`🔄 Fixing invalid shift_type 'day' in ${day} for schedule ${schedule._id}`);
              shift.shift_type = 'morning'; // Replace 'day' with 'morning'
              needsUpdate = true;
            }
          }
        }
      }
      
      if (needsUpdate) {
        await schedule.save();
        fixedCount++;
        console.log(`✅ Fixed schedule ${schedule._id}`);
      }
    }
    
    console.log(`🎉 Fixed ${fixedCount} schedules with invalid shift types`);
    
  } catch (error) {
    console.error('❌ Error fixing invalid shift types:', error);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
  }
}

// Run the fix
fixInvalidShiftTypes();
