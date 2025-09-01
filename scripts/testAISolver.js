const mongoose = require('mongoose');
const AISolver = require('../services/aiSolver');
const User = require('../models/User');
const Home = require('../models/Home');
const Service = require('../models/Service');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function testAISolver() {
  try {
    console.log('🧪 Testing AI Solver...');
    
    // Find a home to test with
    const home = await Home.findOne();
    if (!home) {
      console.log('❌ No homes found in database');
      return;
    }
    console.log('🏠 Testing with home:', home.name, 'ID:', home._id);
    
    // Find a service to test with
    const service = await Service.findOne();
    if (!service) {
      console.log('❌ No services found in database');
      return;
    }
    console.log('🔧 Testing with service:', service.name, 'ID:', service._id);
    
    // Check what users exist
    const allUsers = await User.find({}).select('_id name role is_active homes');
    console.log('👥 Total users in system:', allUsers.length);
    
    allUsers.forEach((user, index) => {
      console.log(`  User ${index + 1}:`, {
        id: user._id,
        name: user.name,
        role: user.role,
        is_active: user.is_active,
        homes: user.homes
      });
    });
    
    // Check users specifically for this home
    const homeUsers = await User.find({
      'homes.home_id': home._id,
      is_active: true
    }).select('_id name role is_active homes');
    
    console.log('🏠 Users assigned to home:', homeUsers.length);
    homeUsers.forEach((user, index) => {
      console.log(`  Home User ${index + 1}:`, {
        id: user._id,
        name: user.name,
        role: user.role,
        is_active: user.is_active,
        homes: user.homes
      });
    });
    
    if (homeUsers.length === 0) {
      console.log('❌ No users found for this home - this is the problem!');
      console.log('💡 You need to assign users to homes first');
      return;
    }
    
    // Test AI Solver
    console.log('\n🤖 Testing AI Solver...');
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
      home._id.toString(),
      service._id.toString(),
      []
    );
    
    console.log('✅ AI Solver result:', JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('🎉 AI Solver worked!');
      console.log('📊 Total assignments:', result.assignments.length);
      console.log('👥 Total staff assigned:', result.assignments.reduce((sum, a) => sum + a.assignments.length, 0));
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
testAISolver();
