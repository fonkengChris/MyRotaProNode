const mongoose = require('mongoose');
const AISolver = require('../services/aiSolver');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');
const WeeklySchedule = require('../models/WeeklySchedule');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function testAISolverWithPeaceHome() {
  try {
    console.log('🧪 Testing AI Solver with Peace Home...');
    
    // Find Peace Home specifically
    const peaceHome = await Home.findOne({ name: { $regex: /peace/i } });
    if (!peaceHome) {
      console.log('❌ Peace Home not found in database');
      return;
    }
    console.log('🏠 Testing with Peace Home:', peaceHome.name, 'ID:', peaceHome._id);
    
    // Verify Peace Home has weekly schedule
    const peaceHomeSchedule = await WeeklySchedule.findOne({ home_id: peaceHome._id });
    if (!peaceHomeSchedule) {
      console.log('❌ No weekly schedule found for Peace Home');
      return;
    }
    console.log('📅 Peace Home weekly schedule found');
    
    // Display Peace Home's shift patterns
    console.log('\n📋 Peace Home Shift Patterns:');
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    days.forEach(day => {
      const daySchedule = peaceHomeSchedule.schedule[day];
      if (daySchedule && daySchedule.is_active && daySchedule.shifts) {
        console.log(`  ${day.charAt(0).toUpperCase() + day.slice(1)}:`);
        daySchedule.shifts.forEach((shift, index) => {
          console.log(`    Shift ${index + 1}: ${shift.start_time} - ${shift.end_time} (${shift.shift_type}) - ${shift.required_staff_count} staff`);
        });
      }
    });
    
    // Find a service to test with
    const service = await Service.findOne();
    if (!service) {
      console.log('❌ No services found in database');
      return;
    }
    console.log('🔧 Testing with service:', service.name, 'ID:', service._id);
    
    // Check what users exist for Peace Home
    const peaceHomeUsers = await User.find({
      'homes.home_id': peaceHome._id,
      is_active: true
    }).select('_id name role is_active homes');
    
    console.log('👥 Users assigned to Peace Home:', peaceHomeUsers.length);
    peaceHomeUsers.forEach((user, index) => {
      console.log(`  User ${index + 1}:`, {
        id: user._id,
        name: user.name,
        role: user.role,
        is_active: user.is_active
      });
    });
    
    if (peaceHomeUsers.length === 0) {
      console.log('❌ No users found for Peace Home - this is the problem!');
      return;
    }
    
    // Test AI Solver
    console.log('\n🤖 Testing AI Solver with Peace Home...');
    const aiSolver = new AISolver();
    
    // Set up test dates (current week)
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1); // Monday
    weekStart.setHours(0, 0, 0, 0);
    
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6); // Sunday
    weekEnd.setHours(23, 59, 59, 999);
    
    console.log('📅 Test week:', weekStart.toISOString(), 'to', weekEnd.toISOString());
    
    const result = await aiSolver.generateRota(
      weekStart,
      weekEnd,
      peaceHome._id.toString(),
      service._id.toString(),
      []
    );
    
    console.log('✅ AI Solver result:', JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('🎉 AI Solver worked!');
      console.log('📊 Total assignments:', result.assignments.length);
      console.log('👥 Total staff assigned:', result.assignments.reduce((sum, a) => sum + a.assignments.length, 0));
      
      // Verify that shifts follow Peace Home pattern
      console.log('\n🔍 Verifying shift patterns match Peace Home schedule:');
      result.assignments.forEach((assignment, index) => {
        const shift = assignment.shift;
        console.log(`  Shift ${index + 1}: ${shift.start_time} - ${shift.end_time} (${shift.shift_type}) - ${shift.required_staff_count} staff required`);
        
        // Check if this matches Peace Home pattern
        const isDayShift = shift.start_time === '08:00' && shift.end_time === '20:00';
        const isNightShift = shift.start_time === '20:00' && shift.end_time === '08:00';
        
        if (isDayShift) {
          console.log(`    ✅ Matches Peace Home day shift pattern`);
        } else if (isNightShift) {
          console.log(`    ✅ Matches Peace Home night shift pattern`);
        } else {
          console.log(`    ❌ Does NOT match Peace Home pattern`);
        }
      });
    } else {
      console.log('❌ AI Solver failed:', result.error);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    mongoose.connection.close();
  }
}

// Run the test
testAISolverWithPeaceHome();
