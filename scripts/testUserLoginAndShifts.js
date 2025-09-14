const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const User = require('../models/User');
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const Service = require('../models/Service');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

async function testUserLoginAndShifts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    // Find user by email
    const user = await User.findOne({ email: 'hope_house_bank_1@rcs.com' });
    
    if (!user) {
      console.log('❌ User not found');
      return;
    }
    
    console.log('👤 USER LOGIN TEST:');
    console.log('=' .repeat(50));
    console.log('Email:', user.email);
    console.log('Name:', user.name);
    console.log('Is Active:', user.is_active);
    
    // Test password (assuming it's 'password123' based on common test patterns)
    const testPassword = 'password123';
    const isPasswordValid = await bcrypt.compare(testPassword, user.password);
    
    if (!isPasswordValid) {
      console.log('❌ Password test failed - trying other common passwords...');
      
      // Try other common test passwords
      const commonPasswords = ['password', '123456', 'admin', 'test'];
      let validPassword = null;
      
      for (const pwd of commonPasswords) {
        if (await bcrypt.compare(pwd, user.password)) {
          validPassword = pwd;
          break;
        }
      }
      
      if (validPassword) {
        console.log(`✅ Password found: ${validPassword}`);
      } else {
        console.log('❌ No common password matches');
        console.log('💡 You may need to reset the password or check the user creation script');
        return;
      }
    } else {
      console.log('✅ Password test passed: password123');
    }
    
    // Generate JWT token (same as auth route)
    const token = jwt.sign(
      { 
        userId: user._id, 
        email: user.email, 
        role: user.role 
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );
    
    console.log('\n🔑 AUTHENTICATION TOKEN:');
    console.log('=' .repeat(50));
    console.log('Token:', token.substring(0, 50) + '...');
    
    // Test the available shifts logic directly (simulating the API)
    console.log('\n🔍 TESTING AVAILABLE SHIFTS LOGIC:');
    console.log('=' .repeat(50));
    
    const startDate = '2025-09-01';
    const endDate = '2025-09-07';
    
    // Get user's home IDs
    const targetHomeIds = user.homes ? user.homes.map(home => home.home_id.toString()) : [];
    console.log('User Home IDs:', targetHomeIds);
    
    if (targetHomeIds.length === 0) {
      console.log('❌ No home IDs found');
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
        return false;
      }
      
      // Check if user is already assigned to this shift
      const isAlreadyAssigned = currentAssignments.some(assignment => 
        assignment.user_id.toString() === user._id.toString()
      );
      
      return !isAlreadyAssigned;
    });
    
    console.log(`\n📊 RESULT: ${availableShifts.length} available shifts for user`);
    
    if (availableShifts.length > 0) {
      console.log('\n✅ AVAILABLE SHIFTS:');
      availableShifts.forEach((shift, index) => {
        const assignedCount = shift.assigned_staff?.length || 0;
        const requiredCount = shift.required_staff_count || 1;
        console.log(`${index + 1}. ${shift.date} ${shift.start_time}-${shift.end_time} at ${shift.home_id.name} (${shift.shift_type}) - ${assignedCount}/${requiredCount} staff`);
      });
      
      console.log('\n💡 SOLUTION:');
      console.log('The user should see these shifts in the Shift Selection page.');
      console.log('If they don\'t see them, check:');
      console.log('1. User is logged in with valid token');
      console.log('2. Frontend is calling the correct API endpoint');
      console.log('3. Browser network tab shows successful API calls');
    } else {
      console.log('\n❌ No available shifts found');
    }
    
    // Test API call with token
    console.log('\n🌐 TESTING API CALL WITH TOKEN:');
    console.log('=' .repeat(50));
    
    const axios = require('axios');
    try {
      const response = await axios.get(`http://localhost:5000/api/shifts/available`, {
        params: {
          user_id: user._id.toString(),
          start_date: startDate,
          end_date: endDate
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('✅ API call successful!');
      console.log('Response:', JSON.stringify(response.data, null, 2));
      
    } catch (apiError) {
      console.log('❌ API call failed:', apiError.response?.data || apiError.message);
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

testUserLoginAndShifts();
