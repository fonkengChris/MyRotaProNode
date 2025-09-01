const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

async function updateUserHomes() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    
    // Find users who have a home_id field but don't have it in their homes array
    const usersNeedingUpdate = await db.collection('users').find({
      home_id: { $exists: true, $ne: null }
    }).toArray();

    console.log(`📊 Found ${usersNeedingUpdate.length} users with home_id field`);

    if (usersNeedingUpdate.length === 0) {
      console.log('No users found with home_id field');
      return;
    }

    let updatedCount = 0;
    let errors = [];

    for (const user of usersNeedingUpdate) {
      try {
        console.log(`🔄 Processing user: ${user.name} (${user.email})`);
        console.log(`   Current home_id: ${user.home_id}`);
        console.log(`   Current homes array:`, user.homes);

        // Check if this home is already in the homes array
        const homeExists = user.homes && user.homes.some(home => 
          home.home_id && home.home_id.toString() === user.home_id.toString()
        );

        if (homeExists) {
          console.log(`   ⚠️  Home already exists in homes array, skipping...`);
          continue;
        }

        // Clear existing homes array and add the home_id as the first and default entry
        const newHomesArray = [{
          home_id: user.home_id,
          is_default: true
        }];

        // Update the user document
        const result = await db.collection('users').updateOne(
          { _id: user._id },
          { 
            $set: { 
              homes: newHomesArray 
            },
            $unset: { 
              home_id: "" 
            }
          }
        );

        if (result.modifiedCount > 0) {
          console.log(`   ✅ Updated successfully`);
          console.log(`   New homes array:`, newHomesArray);
          updatedCount++;
        } else {
          console.log(`   ⚠️  No changes made`);
        }
        
      } catch (error) {
        console.error(`   ❌ Error updating user ${user.name}:`, error.message);
        errors.push({ userId: user._id, name: user.name, error: error.message });
      }
    }

    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`✅ Successfully updated: ${updatedCount} users`);
    console.log(`❌ Failed to update: ${errors.length} users`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach(error => {
        console.log(`  - ${error.name}: ${error.error}`);
      });
    }

    // Verify the changes
    console.log('\n🔍 Verifying changes...');
    const updatedUsers = await db.collection('users').find({
      homes: { $exists: true, $ne: [] }
    }).toArray();
    console.log(`Users with homes array: ${updatedUsers.length}`);

    const usersWithOldHomeId = await db.collection('users').find({
      home_id: { $exists: true, $ne: null, $ne: '' }
    }).toArray();
    console.log(`Users still with home_id field: ${usersWithOldHomeId.length}`);

  } catch (error) {
    console.error('❌ Script error:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  }
}

// Run the script
updateUserHomes().catch(console.error);
