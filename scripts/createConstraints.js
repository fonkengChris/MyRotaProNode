const mongoose = require('mongoose');
const ConstraintWeights = require('../models/ConstraintWeights');

/**
 * Simple script to create default constraints in the database
 */
async function createConstraints() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB');

    // Check if constraints already exist
    const existingConstraints = await ConstraintWeights.countDocuments();
    console.log(`📊 Found ${existingConstraints} existing constraints in database`);

    if (existingConstraints > 0) {
      console.log('✅ Constraints already exist. Skipping creation.');
      
      // Show existing constraints
      const constraints = await ConstraintWeights.find().sort('name');
      console.log('\n📋 Existing constraints:');
      constraints.forEach(constraint => {
        console.log(`   - ${constraint.name} (${constraint.constraint_type})`);
      });
    } else {
      console.log('🔧 Creating default constraints...');
      
      // Create a test user ID for the constraints
      const testUserId = new mongoose.Types.ObjectId();
      
      // Create default constraints
      const createdConstraints = await ConstraintWeights.createDefaultWeights(testUserId);
      console.log(`✅ Created ${createdConstraints.length} default constraints`);
      
      // Show created constraints
      console.log('\n📋 Created constraints:');
      createdConstraints.forEach(constraint => {
        console.log(`   - ${constraint.name} (${constraint.constraint_type})`);
        if (constraint.parameters && Object.keys(constraint.parameters).length > 0) {
          console.log(`     Parameters: ${JSON.stringify(constraint.parameters)}`);
        }
      });
    }

    console.log('\n✅ Constraint setup completed!');
    console.log('💡 Now you can run: node scripts/testHoursConstraints.js');

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
  createConstraints();
}

module.exports = { createConstraints };
