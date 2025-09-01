const mongoose = require('mongoose');
const ConstraintWeights = require('../models/ConstraintWeights');

/**
 * Test script to demonstrate the new hours constraints
 * This script shows how the constraint system handles different employment types
 */
async function testHoursConstraints() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB');

    // Check if constraints exist
    const totalConstraints = await ConstraintWeights.countDocuments();
    console.log(`📊 Found ${totalConstraints} total constraints in database`);

    if (totalConstraints === 0) {
      console.log('❌ No constraints found in database!');
      console.log('💡 You need to create the default constraints first.');
      console.log('   Run: node scripts/setupAndTestConstraints.js');
      console.log('');
      return;
    }

    // Test different employment types and hours
    const testCases = [
      { userType: 'fulltime', actualHours: 35, targetHours: 38, expectedViolations: ['min_hours_per_week'] },
      { userType: 'fulltime', actualHours: 85, targetHours: 38, expectedViolations: ['max_hours_per_week'] },
      { userType: 'fulltime', actualHours: 40, targetHours: 38, expectedViolations: [] },
      { userType: 'parttime', actualHours: 0, targetHours: 20, expectedViolations: [] },
      { userType: 'parttime', actualHours: 25, targetHours: 20, expectedViolations: ['max_hours_per_week'] },
      { userType: 'parttime', actualHours: 20, targetHours: 20, expectedViolations: [] },
      { userType: 'bank', actualHours: 0, targetHours: 0, expectedViolations: [] },
      { userType: 'bank', actualHours: 25, targetHours: 0, expectedViolations: ['max_hours_per_week'] }
    ];

    console.log('🧪 Testing Hours Constraints\n');

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

    // Test specific constraint types
    console.log('🔍 Testing Individual Constraint Types\n');
    
    const hourConstraints = await ConstraintWeights.find({
      is_active: true,
      constraint_type: { $in: ['min_hours_per_week', 'max_hours_per_week', 'employment_type_compliance'] }
    });

    for (const constraint of hourConstraints) {
      console.log(`📋 Testing: ${constraint.name}`);
      console.log(`   Type: ${constraint.constraint_type}`);
      console.log(`   Category: ${constraint.category}`);
      console.log(`   Weight: ${constraint.weight}`);
      
      // Test with different scenarios
      const testScenarios = [
        { userType: 'fulltime', hours: 30, description: 'Fulltime working 30h (below min 38h)' },
        { userType: 'fulltime', hours: 85, description: 'Fulltime working 85h (above max 80h)' },
        { userType: 'parttime', hours: 0, description: 'Part-time working 0h (within 0-20h range)' },
        { userType: 'parttime', hours: 25, description: 'Part-time working 25h (above max 20h)' },
        { userType: 'bank', hours: 0, description: 'Bank working 0h (within 0-20h range)' },
        { userType: 'bank', hours: 25, description: 'Bank working 25h (above max 20h)' }
      ];

      for (const scenario of testScenarios) {
        const penalty = constraint.calculateHoursPenalty(scenario.userType, scenario.hours, 40);
        console.log(`   ${scenario.description}: Penalty = ${penalty}`);
      }

      // Test shift priority if it's a shift_priority constraint
      if (constraint.constraint_type === 'shift_priority') {
        console.log('   Testing shift priority calculations:');
        const testUsers = [
          { type: 'fulltime', name: 'John (Fulltime)' },
          { type: 'parttime', name: 'Jane (Part-time)' },
          { type: 'bank', name: 'Bob (Bank)' }
        ];
        
        for (const user of testUsers) {
          const priority = constraint.calculateShiftPriority(user.type, testUsers);
          console.log(`     ${user.name}: Priority Score = ${priority.toFixed(3)}`);
        }
      }
      console.log('');
    }

    console.log('✅ Hours constraint testing completed!');

  } catch (error) {
    console.error('❌ Test script failed:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Run the test if this script is executed directly
if (require.main === module) {
  testHoursConstraints();
}

module.exports = { testHoursConstraints };
