const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const Shift = require('../models/Shift');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');

async function debugAvailableShifts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    const user_id = '68b0d1ab3a156bb2f93388ed';
    const start_date = '2025-09-01';
    const end_date = '2025-09-07';

    console.log('🔍 DEBUGGING AVAILABLE SHIFTS API LOGIC:');
    console.log('=' .repeat(60));
    console.log('User ID:', user_id);
    console.log('Start Date:', start_date);
    console.log('End Date:', end_date);

    // Step 1: Get user's homes
    console.log('\n📋 STEP 1: Get user\'s homes');
    const user = await User.findById(user_id).select('homes');
    if (!user) {
      console.log('❌ User not found');
      return;
    }
    
    console.log('User homes:', user.homes);
    const targetHomeIds = user.homes ? user.homes.map(home => home.home_id.toString()) : [];
    console.log('Target Home IDs:', targetHomeIds);

    if (targetHomeIds.length === 0) {
      console.log('❌ No home IDs found');
      return;
    }

    // Step 2: Get shifts in user's homes for the date range
    console.log('\n📋 STEP 2: Get shifts in user\'s homes');
    const shifts = await Shift.find({
      home_id: { $in: targetHomeIds },
      date: { $gte: start_date, $lte: end_date },
      is_active: true
    }).populate('service_id', 'name').populate('home_id', 'name');

    console.log(`Found ${shifts.length} shifts in user's homes for this week`);

    if (shifts.length === 0) {
      console.log('❌ No shifts found for this week');
      return;
    }

    // Step 3: Filter to available shifts
    console.log('\n📋 STEP 3: Filter to available shifts');
    const availableShifts = shifts.filter(shift => {
      const currentAssignments = shift.assigned_staff || [];
      const requiredStaff = shift.required_staff_count || 1;
      
      console.log(`\nShift ${shift._id}:`);
      console.log(`  Date: ${shift.date}`);
      console.log(`  Time: ${shift.start_time}-${shift.end_time}`);
      console.log(`  Home: ${shift.home_id?.name}`);
      console.log(`  Assigned: ${currentAssignments.length}/${requiredStaff}`);
      
      // Check if shift needs more staff
      if (currentAssignments.length >= requiredStaff) {
        console.log(`  ❌ Fully staffed`);
        return false;
      }
      
      // Check if user is already assigned to this shift
      const isAlreadyAssigned = currentAssignments.some(assignment => 
        assignment.user_id.toString() === user_id
      );
      
      if (isAlreadyAssigned) {
        console.log(`  ❌ User already assigned`);
        return false;
      }
      
      console.log(`  ✅ Available`);
      return true;
    });

    console.log(`\n📊 RESULT: ${availableShifts.length} available shifts`);
    
    if (availableShifts.length > 0) {
      console.log('\n✅ AVAILABLE SHIFTS:');
      availableShifts.forEach((shift, index) => {
        const assignedCount = shift.assigned_staff?.length || 0;
        const requiredCount = shift.required_staff_count || 1;
        console.log(`${index + 1}. ${shift.date} ${shift.start_time}-${shift.end_time} at ${shift.home_id.name} (${shift.shift_type}) - ${assignedCount}/${requiredCount} staff`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

debugAvailableShifts();
