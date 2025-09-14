const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const Shift = require('../models/Shift');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');

async function findUnassignedShiftsAndUsers() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    // Find unassigned shifts (shifts with no assigned staff)
    const unassignedShifts = await Shift.find({
      is_active: true,
      $expr: { $eq: [{ $size: "$assigned_staff" }, 0] }
    })
    .populate('home_id', 'name location')
    .populate('service_id', 'name category')
    .sort({ date: 1, start_time: 1 });

    console.log(`🔍 Found ${unassignedShifts.length} unassigned shifts\n`);

    if (unassignedShifts.length === 0) {
      console.log('❌ No unassigned shifts found in the database');
      return;
    }

    // Display unassigned shifts
    console.log('📋 UNASSIGNED SHIFTS:');
    console.log('=' .repeat(80));
    
    for (let i = 0; i < Math.min(5, unassignedShifts.length); i++) {
      const shift = unassignedShifts[i];
      console.log(`\n${i + 1}. Shift ID: ${shift._id}`);
      console.log(`   Date: ${shift.date}`);
      console.log(`   Time: ${shift.start_time} - ${shift.end_time}`);
      console.log(`   Type: ${shift.shift_type}`);
      console.log(`   Home: ${shift.home_id?.name || 'Unknown'}`);
      console.log(`   Service: ${shift.service_id?.name || 'Unknown'}`);
      console.log(`   Required Staff: ${shift.required_staff_count}`);
      console.log(`   Duration: ${shift.duration_hours} hours`);
      console.log(`   Status: ${shift.status}`);
    }

    // Pick the first unassigned shift for analysis
    const targetShift = unassignedShifts[0];
    console.log(`\n🎯 ANALYZING SHIFT: ${targetShift._id}`);
    console.log(`   Home: ${targetShift.home_id?.name}`);
    console.log(`   Date: ${targetShift.date} (${targetShift.start_time} - ${targetShift.end_time})`);

    // Find users assigned to the same home
    const eligibleUsers = await User.find({
      'homes.home_id': targetShift.home_id._id,
      is_active: true
    }).sort({ name: 1 });

    console.log(`\n👥 ELIGIBLE USERS FOR THIS SHIFT:`);
    console.log('=' .repeat(80));
    console.log(`Found ${eligibleUsers.length} users assigned to ${targetShift.home_id?.name}`);

    if (eligibleUsers.length === 0) {
      console.log('❌ No users assigned to this home');
      return;
    }

    // Display eligible users
    for (let i = 0; i < Math.min(10, eligibleUsers.length); i++) {
      const user = eligibleUsers[i];
      console.log(`\n${i + 1}. ${user.name}`);
      console.log(`   ID: ${user._id}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Type: ${user.type}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   Phone: ${user.phone}`);
      console.log(`   Min Hours/Week: ${user.min_hours_per_week}`);
      console.log(`   Max Hours/Week: ${user.max_hours_per_week}`);
      console.log(`   Skills: ${user.skills?.join(', ') || 'None'}`);
      console.log(`   Preferred Shifts: ${user.preferred_shift_types?.join(', ') || 'None'}`);
    }

    // Check for conflicts - find users already assigned to shifts on the same date
    const sameDateShifts = await Shift.find({
      date: targetShift.date,
      is_active: true,
      'assigned_staff.user_id': { $in: eligibleUsers.map(u => u._id) }
    }).populate('assigned_staff.user_id', 'name');

    console.log(`\n⚠️  CONFLICT CHECK:`);
    console.log('=' .repeat(80));
    
    if (sameDateShifts.length === 0) {
      console.log('✅ No conflicts found - all users are available on this date');
    } else {
      console.log(`Found ${sameDateShifts.length} shifts on the same date with assigned users:`);
      
      const conflictedUserIds = new Set();
      sameDateShifts.forEach(shift => {
        shift.assigned_staff.forEach(assignment => {
          conflictedUserIds.add(assignment.user_id._id.toString());
          console.log(`   - ${assignment.user_id.name} already assigned to ${shift.start_time}-${shift.end_time} shift`);
        });
      });

      // Filter out conflicted users
      const availableUsers = eligibleUsers.filter(user => 
        !conflictedUserIds.has(user._id.toString())
      );

      console.log(`\n✅ AVAILABLE USERS (no conflicts): ${availableUsers.length}`);
      if (availableUsers.length > 0) {
        console.log('Top candidates:');
        availableUsers.slice(0, 3).forEach((user, index) => {
          console.log(`   ${index + 1}. ${user.name} (${user.type}, ${user.role})`);
        });
      }
    }

    // Suggest assignment
    console.log(`\n💡 RECOMMENDED ASSIGNMENT:`);
    console.log('=' .repeat(80));
    
    if (eligibleUsers.length > 0) {
      const bestCandidate = eligibleUsers[0];
      console.log(`Shift: ${targetShift._id}`);
      console.log(`Date: ${targetShift.date}`);
      console.log(`Time: ${targetShift.start_time} - ${targetShift.end_time}`);
      console.log(`Home: ${targetShift.home_id?.name}`);
      console.log(`Service: ${targetShift.service_id?.name}`);
      console.log(`\nRecommended User: ${bestCandidate.name}`);
      console.log(`User ID: ${bestCandidate._id}`);
      console.log(`Role: ${bestCandidate.role}`);
      console.log(`Type: ${bestCandidate.type}`);
      console.log(`Email: ${bestCandidate.email}`);
      
      console.log(`\n📝 ASSIGNMENT COMMAND:`);
      console.log(`You can assign this shift using:`);
      console.log(`node scripts/assignShiftToUser.js ${targetShift._id} ${bestCandidate._id}`);
    }

  } catch (error) {
    console.error('❌ Script error:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

// Run the script
findUnassignedShiftsAndUsers();
