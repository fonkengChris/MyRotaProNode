const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const Shift = require('../models/Shift');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');

async function assignShiftToUser(shiftId, userId) {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    // Validate inputs
    if (!shiftId || !userId) {
      console.log('❌ Usage: node assignShiftToUser.js <shiftId> <userId>');
      console.log('Example: node assignShiftToUser.js 68a7a90b31d0654bc488e534 68b0d1ab3a156bb2f93388ed');
      return;
    }

    // Find the shift
    const shift = await Shift.findById(shiftId)
      .populate('home_id', 'name location')
      .populate('service_id', 'name category');

    if (!shift) {
      console.log(`❌ Shift with ID ${shiftId} not found`);
      return;
    }

    // Find the user
    const user = await User.findById(userId);

    if (!user) {
      console.log(`❌ User with ID ${userId} not found`);
      return;
    }

    // Check if user is assigned to the same home
    const userHomeIds = user.homes?.map(home => home.home_id.toString()) || [];
    const shiftHomeId = shift.home_id._id.toString();

    if (!userHomeIds.includes(shiftHomeId)) {
      console.log(`❌ User ${user.name} is not assigned to home ${shift.home_id.name}`);
      console.log(`   User homes: ${userHomeIds.join(', ')}`);
      console.log(`   Shift home: ${shiftHomeId}`);
      return;
    }

    // Check if user is already assigned to this shift
    const isAlreadyAssigned = shift.assigned_staff.some(assignment => 
      assignment.user_id.toString() === userId
    );

    if (isAlreadyAssigned) {
      console.log(`❌ User ${user.name} is already assigned to this shift`);
      return;
    }

    // Check if shift is fully staffed
    if (shift.assigned_staff.length >= shift.required_staff_count) {
      console.log(`❌ Shift is already fully staffed (${shift.assigned_staff.length}/${shift.required_staff_count})`);
      return;
    }

    // Check for conflicts - find other shifts on the same date
    const conflictingShifts = await Shift.find({
      date: shift.date,
      is_active: true,
      'assigned_staff.user_id': userId,
      _id: { $ne: shiftId }
    });

    if (conflictingShifts.length > 0) {
      console.log(`⚠️  WARNING: User ${user.name} is already assigned to ${conflictingShifts.length} shift(s) on ${shift.date}:`);
      conflictingShifts.forEach(conflictShift => {
        console.log(`   - ${conflictShift.start_time} - ${conflictShift.end_time} (${conflictShift.shift_type})`);
      });
      console.log('   Proceeding with assignment anyway...\n');
    }

    // Display shift and user info
    console.log('📋 ASSIGNMENT DETAILS:');
    console.log('=' .repeat(60));
    console.log(`Shift ID: ${shift._id}`);
    console.log(`Date: ${shift.date}`);
    console.log(`Time: ${shift.start_time} - ${shift.end_time}`);
    console.log(`Type: ${shift.shift_type}`);
    console.log(`Home: ${shift.home_id.name}`);
    console.log(`Service: ${shift.service_id.name}`);
    console.log(`Duration: ${shift.duration_hours} hours`);
    console.log(`Current Staff: ${shift.assigned_staff.length}/${shift.required_staff_count}`);
    console.log(`\nUser: ${user.name}`);
    console.log(`User ID: ${user._id}`);
    console.log(`Role: ${user.role}`);
    console.log(`Type: ${user.type}`);
    console.log(`Email: ${user.email}`);

    // Assign the user to the shift
    shift.assignStaff(userId, `Assigned via script on ${new Date().toISOString()}`);
    await shift.save();

    console.log('\n✅ ASSIGNMENT SUCCESSFUL!');
    console.log(`   User ${user.name} has been assigned to the ${shift.shift_type} shift on ${shift.date}`);
    console.log(`   Shift now has ${shift.assigned_staff.length}/${shift.required_staff_count} staff members`);

    // Verify the assignment
    const updatedShift = await Shift.findById(shiftId).populate('assigned_staff.user_id', 'name email');
    console.log('\n📊 UPDATED SHIFT STATUS:');
    console.log('=' .repeat(60));
    console.log(`Status: ${updatedShift.status}`);
    console.log(`Assigned Staff:`);
    updatedShift.assigned_staff.forEach((assignment, index) => {
      console.log(`   ${index + 1}. ${assignment.user_id.name} (${assignment.user_id.email}) - ${assignment.status}`);
    });

  } catch (error) {
    console.error('❌ Assignment error:', error.message);
    if (error.message.includes('Staff member is already assigned')) {
      console.log('   This user is already assigned to this shift');
    } else if (error.message.includes('Shift is already fully staffed')) {
      console.log('   This shift already has the required number of staff members');
    }
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

// Get command line arguments
const args = process.argv.slice(2);
const shiftId = args[0];
const userId = args[1];

// Run the assignment
assignShiftToUser(shiftId, userId);
