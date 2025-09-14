const axios = require('axios');

async function testLoginAndShifts() {
  try {
    console.log('🔐 Testing login and available shifts API...\n');
    
    // First, login to get a token
    const loginResponse = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'hope_house_bank_1@rcs.com',
      password: 'passWord123'
    });
    
    const token = loginResponse.data.token;
    console.log('✅ Login successful!');
    console.log('User:', loginResponse.data.user.name);
    console.log('Token:', token.substring(0, 50) + '...\n');
    
    // Now test the available shifts API
    const shiftsResponse = await axios.get('http://localhost:5000/api/shifts/available', {
      params: {
        user_id: '68b0d1ab3a156bb2f93388ed',
        start_date: '2025-09-01',
        end_date: '2025-09-07'
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ Available shifts API successful!');
    console.log('Number of available shifts:', shiftsResponse.data.length);
    
    if (shiftsResponse.data.length > 0) {
      console.log('\n📋 AVAILABLE SHIFTS:');
      console.log('=' .repeat(60));
      shiftsResponse.data.forEach((shift, index) => {
        const assignedCount = shift.assigned_staff?.length || 0;
        const requiredCount = shift.required_staff_count || 1;
        console.log(`${index + 1}. ${shift.date} ${shift.start_time}-${shift.end_time} at ${shift.home_id.name} (${shift.shift_type}) - ${assignedCount}/${requiredCount} staff`);
      });
      
      console.log('\n💡 SOLUTION:');
      console.log('The user can now log in and should see these shifts in the Shift Selection page!');
    } else {
      console.log('\n❌ No available shifts found');
      console.log('This means all shifts are fully staffed or the user is already assigned to all shifts.');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      console.log('\n💡 Authentication failed - check login credentials');
    } else if (error.response?.status === 500) {
      console.log('\n💡 Server error - check server logs');
    }
  }
}

testLoginAndShifts();
