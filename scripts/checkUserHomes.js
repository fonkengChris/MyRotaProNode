const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const User = require('../models/User');
const Home = require('../models/Home');

async function checkUserHomes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    // Find user by email
    const user = await User.findOne({ email: 'hope_house_bank_1@rcs.com' });
    
    if (!user) {
      console.log('❌ User not found');
      return;
    }
    
    console.log('👤 USER DETAILS:');
    console.log('=' .repeat(50));
    console.log('ID:', user._id);
    console.log('Name:', user.name);
    console.log('Email:', user.email);
    console.log('Role:', user.role);
    console.log('Type:', user.type);
    console.log('Is Active:', user.is_active);
    console.log('Homes:', JSON.stringify(user.homes, null, 2));
    
    // Check if homes exist
    if (user.homes && user.homes.length > 0) {
      console.log('\n🏠 HOME DETAILS:');
      console.log('=' .repeat(50));
      
      for (const homeRef of user.homes) {
        const home = await Home.findById(homeRef.home_id);
        if (home) {
          console.log('Home ID:', home._id);
          console.log('Home Name:', home.name);
          console.log('Is Default:', homeRef.is_default);
          console.log('---');
        } else {
          console.log('❌ Home not found for ID:', homeRef.home_id);
        }
      }
    } else {
      console.log('❌ User has no homes assigned');
    }

    // Test the available shifts API logic
    console.log('\n🔍 TESTING AVAILABLE SHIFTS LOGIC:');
    console.log('=' .repeat(50));
    
    const Shift = require('../models/Shift');
    const startDate = '2025-01-20'; // Current week start
    const endDate = '2025-01-26';   // Current week end
    
    console.log(`Checking shifts from ${startDate} to ${endDate}`);
    
    // Get user's home IDs
    const targetHomeIds = user.homes ? user.homes.map(home => home.home_id.toString()) : [];
    console.log('Target Home IDs:', targetHomeIds);
    
    if (targetHomeIds.length === 0) {
      console.log('❌ No home IDs found - this is why no shifts are available');
      return;
    }
    
    // Get shifts that need more staff in user's homes
    const shifts = await Shift.find({
      home_id: { $in: targetHomeIds },
      date: { $gte: startDate, $lte: endDate },
      is_active: true
    }).populate('service_id', 'name').populate('home_id', 'name');
    
    console.log(`Found ${shifts.length} shifts in user's homes for this week`);
    
    // Filter to shifts that need more staff and user isn't already assigned to
    const availableShifts = shifts.filter(shift => {
      const currentAssignments = shift.assigned_staff || [];
      const requiredStaff = shift.required_staff_count || 1;
      
      // Check if shift needs more staff
      if (currentAssignments.length >= requiredStaff) {
        console.log(`❌ Shift ${shift._id} is fully staffed (${currentAssignments.length}/${requiredStaff})`);
        return false;
      }
      
      // Check if user is already assigned to this shift
      const isAlreadyAssigned = currentAssignments.some(assignment => 
        assignment.user_id.toString() === user._id.toString()
      );
      
      if (isAlreadyAssigned) {
        console.log(`❌ User already assigned to shift ${shift._id}`);
        return false;
      }
      
      console.log(`✅ Shift ${shift._id} is available: ${shift.date} ${shift.start_time}-${shift.end_time} (${currentAssignments.length}/${requiredStaff} staff)`);
      return true;
    });
    
    console.log(`\n📊 RESULT: ${availableShifts.length} available shifts for user`);
    
    if (availableShifts.length > 0) {
      console.log('\nAvailable shifts:');
      availableShifts.forEach((shift, index) => {
        console.log(`${index + 1}. ${shift.date} ${shift.start_time}-${shift.end_time} at ${shift.home_id.name} (${shift.shift_type})`);
      });
    } else {
      console.log('\n❌ No available shifts found');
      console.log('Possible reasons:');
      console.log('- All shifts are fully staffed');
      console.log('- User is already assigned to all shifts');
      console.log('- No shifts exist for this week');
      console.log('- User has no homes assigned');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

checkUserHomes();