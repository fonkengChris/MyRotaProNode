const mongoose = require('mongoose');
const ConstraintWeights = require('../models/ConstraintWeights');

/**
 * Comprehensive script to set up default constraints and test them
 * This script ensures the constraint system is properly initialized
 */
async function setupAndTestConstraints() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB');

    // Check if constraints already exist
    const existingConstraints = await ConstraintWeights.countDocuments();
    console.log(`📊 Found ${existingConstraints} existing constraints in database`);

    if (existingConstraints === 0) {
      console.log('🔧 No constraints found. Creating default constraints...');
      
      // Create a test user ID for the constraints
      const testUserId = new mongoose.Types.ObjectId();
      
      // Create default constraints
      const createdConstraints = await ConstraintWeights.createDefaultWeights(testUserId);
      console.log(`✅ Created ${createdConstraints.length} default constraints`);
    } else {
      console.log('✅ Constraints already exist in database');
    }

    // Verify the hours constraints exist
    const hourConstraints = await ConstraintWeights.find({
      is_active: true,
      constraint_type: { $in: ['min_hours_per_week', 'max_hours_per_week', 'employment_type_compliance'] }
    });

    console.log(`\n🔍 Found ${hourConstraints.length} hours-related constraints:`);
    hourConstraints.forEach(constraint => {
      console.log(`   - ${constraint.name} (${constraint.constraint_type})`);
      console.log(`     Parameters: ${JSON.stringify(constraint.parameters)}`);
    });

    if (hourConstraints.length === 0) {
      console.log('❌ No hours constraints found! Something went wrong.');
      return;
    }

    // Test different employment types and hours
    console.log('\n🧪 Testing Hours Constraints\n');

    const testCases = [
      { userType: 'fulltime', actualHours: 35, targetHours: 38, expectedViolations: ['min_hours_per_week'] },
      { userType: 'fulltime', actualHours: 45, targetHours: 38, expectedViolations: ['max_hours_per_week'] },
      { userType: 'fulltime', actualHours: 40, targetHours: 38, expectedViolations: [] },
      { userType: 'parttime', actualHours: 15, targetHours: 20, expectedViolations: ['min_hours_per_week'] },
      { userType: 'parttime', actualHours: 25, targetHours: 20, expectedViolations: ['max_hours_per_week'] },
      { userType: 'parttime', actualHours: 20, targetHours: 20, expectedViolations: [] },
      { userType: 'bank', actualHours: 5, targetHours: 0, expectedViolations: ['max_hours_per_week'] },
      { userType: 'bank', actualHours: 0, targetHours: 0, expectedViolations: [] }
    ];

    for (const testCase of testCases) {
      console.log(`📊 Testing ${testCase.userType} staff with ${testCase.actualHours} hours (target: ${testCase.targetHours})`);
      
      try {
        const result = await ConstraintWeights.validateUserHours(
          testCase.userType, 
          testCase.actualHours, 
          testCase.targetHours
        );

        if (result.isValid) {
          if (testCase.expectedViolations.length === 0) {
            console.log('✅ No violations detected (as expected)');
          } else {
            console.log('❌ Expected violations but none detected!');
          }
        } else {
          const detectedViolationTypes = result.violations.map(v => v.constraint_type);
          const expectedViolationTypes = testCase.expectedViolations;
          
          if (JSON.stringify(detectedViolationTypes.sort()) === JSON.stringify(expectedViolationTypes.sort())) {
            console.log('✅ Correct violations detected:');
          } else {
            console.log('❌ Incorrect violations detected:');
          }
          
          result.violations.forEach(violation => {
            console.log(`   - ${violation.message} (Penalty: ${violation.penalty})`);
          });
        }
        
        console.log(`   Total Penalty: ${result.totalPenalty}\n`);
      } catch (error) {
        console.error(`❌ Error testing ${testCase.userType}:`, error.message);
      }
    }

    // Test individual constraints
    console.log('🔍 Testing Individual Constraint Types\n');
    
    for (const constraint of hourConstraints) {
      console.log(`📋 Testing: ${constraint.name}`);
      console.log(`   Type: ${constraint.constraint_type}`);
      console.log(`   Category: ${constraint.category}`);
      console.log(`   Weight: ${constraint.weight}`);
      
      // Test with different scenarios
      const testScenarios = [
        { userType: 'fulltime', hours: 30, description: 'Fulltime working 30h (below min 38h)' },
        { userType: 'fulltime', hours: 50, description: 'Fulltime working 50h (above max 45h)' },
        { userType: 'parttime', hours: 15, description: 'Part-time working 15h (below min 20h)' },
        { userType: 'parttime', hours: 25, description: 'Part-time working 25h (above max 20h)' },
        { userType: 'bank', hours: 10, description: 'Bank working 10h (above max 15h)' },
        { userType: 'bank', hours: 0, description: 'Bank working 0h (within limits)' }
      ];

      for (const scenario of testScenarios) {
        const penalty = constraint.calculateHoursPenalty(scenario.userType, scenario.hours, 40);
        console.log(`   ${scenario.description}: Penalty = ${penalty}`);
      }
      console.log('');
    }

    console.log('✅ Hours constraint testing completed!');

  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Run the script if this script is executed directly
if (require.main === module) {
  setupAndTestConstraints();
}

module.exports = { setupAndTestConstraints };
