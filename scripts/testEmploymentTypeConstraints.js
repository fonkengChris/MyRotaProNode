const mongoose = require('mongoose');
const AISolver = require('../services/aiSolver');
const User = require('../models/User');
const Shift = require('../models/Shift');
const Home = require('../models/Home');
const Service = require('../models/Service');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function testEmploymentTypeConstraints() {
  try {
    console.log('🧪 Testing AI Solver Employment Type Constraints...\n');

    // Find a home and service to test with
    const home = await Home.findOne({ is_active: true });
    const service = await Service.findOne({ is_active: true });

    if (!home || !service) {
      console.log('❌ No active home or service found. Please create them first.');
      return;
    }

    console.log(`🏠 Testing with Home: ${home.name}`);
    console.log(`🔧 Testing with Service: ${service.name}\n`);

    // Get staff members with different employment types
    const staff = await User.find({ 
      'homes.home_id': home._id, 
      is_active: true 
    }).select('_id name type homes');

    if (staff.length === 0) {
      console.log('❌ No staff found for this home. Please add staff members first.');
      return;
    }

    console.log('👥 Staff Members:');
    staff.forEach(member => {
      console.log(`  - ${member.name} (${member.type})`);
    });
    console.log('');

    // Create test shifts for a week
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() + 1); // Start tomorrow
    const shifts = [];

    // Create shifts for each day of the week
    for (let i = 0; i < 7; i++) {
      const currentDate = new Date(weekStart);
      currentDate.setDate(currentDate.getDate() + i);
      
      // Morning shift
      shifts.push({
        _id: `test-morning-${i}`,
        home_id: home._id,
        service_id: service._id,
        date: currentDate.toISOString().split('T')[0],
        start_time: '08:00',
        end_time: '16:00',
        shift_type: 'day',
        required_staff_count: 2,
        assigned_staff: []
      });

      // Evening shift
      shifts.push({
        _id: `test-evening-${i}`,
        home_id: home._id,
        service_id: service._id,
        date: currentDate.toISOString().split('T')[0],
        start_time: '16:00',
        end_time: '22:00',
        shift_type: 'evening',
        required_staff_count: 1,
        assigned_staff: []
      });
    }

    console.log(`📅 Created ${shifts.length} test shifts for the week\n`);

    // Initialize AI solver
    const aiSolver = new AISolver();
    
    // Generate rota
    console.log('🤖 Generating rota with AI solver...\n');
    
    const result = await aiSolver.generateRota(
      weekStart,
      new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000), // 7 days later
      home._id,
      service._id,
      shifts
    );

    if (!result.success) {
      console.log('❌ AI generation failed:', result.error);
      return;
    }

    console.log('✅ AI generation successful!\n');

    // Analyze results
    console.log('📊 Employment Type Distribution:');
    if (result.employment_distribution) {
      const dist = result.employment_distribution;
      
      if (dist.fulltime.staff_count > 0) {
        console.log(`  Full-time: ${dist.fulltime.staff_count} staff, avg ${dist.fulltime.average_hours.toFixed(1)}h`);
      }
      if (dist.parttime.staff_count > 0) {
        console.log(`  Part-time: ${dist.parttime.staff_count} staff, avg ${dist.parttime.average_hours.toFixed(1)}h`);
      }
      if (dist.bank.staff_count > 0) {
        console.log(`  Bank: ${dist.bank.staff_count} staff, avg ${dist.bank.average_hours.toFixed(1)}h`);
      }
    }
    console.log('');

    // Check if constraints are respected
    console.log('🔍 Constraint Validation:');
    
    const staffHours = {};
    staff.forEach(s => {
      staffHours[s._id.toString()] = 0;
    });

    result.assignments.forEach(assignment => {
      const shiftDuration = aiSolver.calculateShiftDuration(assignment.shift.start_time, assignment.shift.end_time);
      
      assignment.assignments.forEach(ass => {
        const staffId = ass.user_id.toString();
        if (staffHours[staffId] !== undefined) {
          staffHours[staffId] += shiftDuration;
        }
      });
    });

    let allConstraintsRespected = true;

    staff.forEach(member => {
      const hours = staffHours[member._id.toString()] || 0;
      const type = member.type;
      
      console.log(`  ${member.name} (${type}): ${hours.toFixed(1)}h`);
      
      // Check constraints
      switch (type) {
        case 'fulltime':
          if (hours < 38) {
            console.log(`    ⚠️  Below minimum hours (38h)`);
            allConstraintsRespected = false;
          } else if (hours > 50) {
            console.log(`    ⚠️  Above recommended hours (50h)`);
            allConstraintsRespected = false;
          } else {
            console.log(`    ✅ Within full-time range (38-50h)`);
          }
          break;
          
        case 'parttime':
          if (hours > 20) {
            console.log(`    ❌ Exceeds part-time limit (20h)`);
            allConstraintsRespected = false;
          } else {
            console.log(`    ✅ Within part-time limit (≤20h)`);
          }
          break;
          
        case 'bank':
          if (hours > 20) {
            console.log(`    ❌ Exceeds bank worker limit (20h)`);
            allConstraintsRespected = false;
          } else if (hours > 15) {
            console.log(`    ⚠️  Above recommended bank hours (15h)`);
            allConstraintsRespected = false;
          } else {
            console.log(`    ✅ Within bank worker range (≤15h)`);
          }
          break;
      }
    });

    console.log('');
    if (allConstraintsRespected) {
      console.log('✅ All employment type constraints respected!');
    } else {
      console.log('⚠️  Some employment type constraints violated. This may be due to insufficient staff or shift requirements.');
    }

    console.log(`\n📈 Total penalty: ${result.total_penalty}`);
    console.log(`🚨 Constraint violations: ${result.constraints_violated.length}`);

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the test
testEmploymentTypeConstraints();
