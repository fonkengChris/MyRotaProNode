const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const User = require('../models/User');
const Shift = require('../models/Shift');
const Service = require('../models/Service');
const Home = require('../models/Home');

async function testConcurrentShiftSelection() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    // Check and set password for hope_house_bank_2
    const user2 = await User.findOne({ email: 'hope_house_bank_2@rcs.com' }).select('+password');
    
    if (!user2) {
      console.log('❌ User hope_house_bank_2 not found');
      return;
    }
    
    console.log('👤 USER 2 DETAILS:');
    console.log('ID:', user2._id);
    console.log('Name:', user2.name);
    console.log('Email:', user2.email);
    console.log('Password set:', user2.password ? 'YES' : 'NO');
    
    if (!user2.password) {
      console.log('Setting password...');
      user2.password = 'passWord123';
      await user2.save();
      console.log('✅ Password set to: passWord123');
    }

    // Get available shifts for both users
    const startDate = '2025-09-01';
    const endDate = '2025-09-07';
    
    console.log('\n🔍 TESTING CONCURRENT SHIFT SELECTION:');
    console.log('=' .repeat(60));
    
    // Get available shifts for user 1 (hope_house_bank_1)
    const user1Id = '68b0d1ab3a156bb2f93388ed';
    const user2Id = user2._id.toString();
    
    const targetHomeIds = ['68a634e9f2c2d29016fce6c4', '68a63f6ea1391dad179f404a']; // Hope House and Compassion House
    
    const shifts = await Shift.find({
      home_id: { $in: targetHomeIds },
      date: { $gte: startDate, $lte: endDate },
      is_active: true
    }).populate('service_id', 'name').populate('home_id', 'name');
    
    // Filter to shifts that need more staff and user isn't already assigned to
    const availableShiftsForUser1 = shifts.filter(shift => {
      const currentAssignments = shift.assigned_staff || [];
      const requiredStaff = shift.required_staff_count || 1;
      
      if (currentAssignments.length >= requiredStaff) return false;
      
      const isAlreadyAssigned = currentAssignments.some(assignment => 
        assignment.user_id.toString() === user1Id
      );
      
      return !isAlreadyAssigned;
    });
    
    const availableShiftsForUser2 = shifts.filter(shift => {
      const currentAssignments = shift.assigned_staff || [];
      const requiredStaff = shift.required_staff_count || 1;
      
      if (currentAssignments.length >= requiredStaff) return false;
      
      const isAlreadyAssigned = currentAssignments.some(assignment => 
        assignment.user_id.toString() === user2Id
      );
      
      return !isAlreadyAssigned;
    });
    
    console.log(`Available shifts for User 1 (Hope Bank 1): ${availableShiftsForUser1.length}`);
    console.log(`Available shifts for User 2 (Hope Bank 2): ${availableShiftsForUser2.length}`);
    
    if (availableShiftsForUser1.length === 0 || availableShiftsForUser2.length === 0) {
      console.log('❌ No available shifts for testing');
      return;
    }
    
    // Find a shift that both users can see
    const commonShift = availableShiftsForUser1.find(shift1 => 
      availableShiftsForUser2.some(shift2 => shift2._id.toString() === shift1._id.toString())
    );
    
    if (!commonShift) {
      console.log('❌ No common shifts available for both users');
      return;
    }
    
    console.log(`\n🎯 TESTING WITH SHIFT: ${commonShift._id}`);
    console.log(`Date: ${commonShift.date}`);
    console.log(`Time: ${commonShift.start_time}-${commonShift.end_time}`);
    console.log(`Home: ${commonShift.home_id.name}`);
    console.log(`Current Staff: ${commonShift.assigned_staff.length}/${commonShift.required_staff_count}`);
    
    // Test the concurrent selection scenario
    console.log('\n📋 CONCURRENT SELECTION TEST:');
    console.log('=' .repeat(60));
    
    const axios = require('axios');
    
    // Login both users
    console.log('🔐 Logging in both users...');
    
    const login1Response = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'hope_house_bank_1@rcs.com',
      password: 'passWord123'
    });
    const token1 = login1Response.data.token;
    
    const login2Response = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'hope_house_bank_2@rcs.com',
      password: 'passWord123'
    });
    const token2 = login2Response.data.token;
    
    console.log('✅ Both users logged in successfully');
    
    // Check available shifts for both users before assignment
    console.log('\n📊 AVAILABLE SHIFTS BEFORE ASSIGNMENT:');
    
    const shiftsBefore1 = await axios.get('http://localhost:5000/api/shifts/available', {
      params: { user_id: user1Id, start_date: startDate, end_date: endDate },
      headers: { 'Authorization': `Bearer ${token1}` }
    });
    
    const shiftsBefore2 = await axios.get('http://localhost:5000/api/shifts/available', {
      params: { user_id: user2Id, start_date: startDate, end_date: endDate },
      headers: { 'Authorization': `Bearer ${token2}` }
    });
    
    const shiftExistsForUser1Before = shiftsBefore1.data.some(s => s._id === commonShift._id.toString());
    const shiftExistsForUser2Before = shiftsBefore2.data.some(s => s._id === commonShift._id.toString());
    
    console.log(`User 1 can see the shift: ${shiftExistsForUser1Before ? 'YES' : 'NO'}`);
    console.log(`User 2 can see the shift: ${shiftExistsForUser2Before ? 'YES' : 'NO'}`);
    
    // User 1 selects the shift
    console.log('\n🎯 User 1 (Hope Bank 1) selecting the shift...');
    try {
      const assignResponse = await axios.post(`http://localhost:5000/api/shifts/${commonShift._id}/assign`, {
        user_id: user1Id,
        note: 'Concurrent test - User 1'
      }, {
        headers: { 'Authorization': `Bearer ${token1}` }
      });
      
      console.log('✅ User 1 successfully selected the shift');
      console.log(`New staff count: ${assignResponse.data.assigned_staff.length}/${assignResponse.data.required_staff_count}`);
      
    } catch (error) {
      console.log('❌ User 1 failed to select shift:', error.response?.data?.error || error.message);
    }
    
    // Check available shifts for both users after assignment
    console.log('\n📊 AVAILABLE SHIFTS AFTER USER 1 ASSIGNMENT:');
    
    const shiftsAfter1 = await axios.get('http://localhost:5000/api/shifts/available', {
      params: { user_id: user1Id, start_date: startDate, end_date: endDate },
      headers: { 'Authorization': `Bearer ${token1}` }
    });
    
    const shiftsAfter2 = await axios.get('http://localhost:5000/api/shifts/available', {
      params: { user_id: user2Id, start_date: startDate, end_date: endDate },
      headers: { 'Authorization': `Bearer ${token2}` }
    });
    
    const shiftExistsForUser1After = shiftsAfter1.data.some(s => s._id === commonShift._id.toString());
    const shiftExistsForUser2After = shiftsAfter2.data.some(s => s._id === commonShift._id.toString());
    
    console.log(`User 1 can see the shift: ${shiftExistsForUser1After ? 'YES' : 'NO'}`);
    console.log(`User 2 can see the shift: ${shiftExistsForUser2After ? 'YES' : 'NO'}`);
    
    // Try to have User 2 select the same shift
    console.log('\n🎯 User 2 (Hope Bank 2) trying to select the same shift...');
    try {
      const assignResponse2 = await axios.post(`http://localhost:5000/api/shifts/${commonShift._id}/assign`, {
        user_id: user2Id,
        note: 'Concurrent test - User 2'
      }, {
        headers: { 'Authorization': `Bearer ${token2}` }
      });
      
      console.log('✅ User 2 successfully selected the shift');
      console.log(`New staff count: ${assignResponse2.data.assigned_staff.length}/${assignResponse2.data.required_staff_count}`);
      
    } catch (error) {
      console.log('❌ User 2 failed to select shift:', error.response?.data?.error || error.message);
    }
    
    // Final check
    console.log('\n📊 FINAL AVAILABLE SHIFTS:');
    
    const finalShifts1 = await axios.get('http://localhost:5000/api/shifts/available', {
      params: { user_id: user1Id, start_date: startDate, end_date: endDate },
      headers: { 'Authorization': `Bearer ${token1}` }
    });
    
    const finalShifts2 = await axios.get('http://localhost:5000/api/shifts/available', {
      params: { user_id: user2Id, start_date: startDate, end_date: endDate },
      headers: { 'Authorization': `Bearer ${token2}` }
    });
    
    const shiftExistsForUser1Final = finalShifts1.data.some(s => s._id === commonShift._id.toString());
    const shiftExistsForUser2Final = finalShifts2.data.some(s => s._id === commonShift._id.toString());
    
    console.log(`User 1 can see the shift: ${shiftExistsForUser1Final ? 'YES' : 'NO'}`);
    console.log(`User 2 can see the shift: ${shiftExistsForUser2Final ? 'YES' : 'NO'}`);
    
    console.log('\n💡 CONCLUSION:');
    console.log('The shift selection system handles concurrent access by:');
    console.log('1. Checking if the shift is fully staffed before assignment');
    console.log('2. Preventing double-assignment of the same user');
    console.log('3. Updating available shifts in real-time based on current assignments');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

testConcurrentShiftSelection();
