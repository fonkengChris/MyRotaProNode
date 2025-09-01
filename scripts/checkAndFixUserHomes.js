const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

async function checkAndFixUserHomes() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    const User = require('../models/User');
    const Home = require('../models/Home');
    
    // Check what homes exist
    const homes = await Home.find({});
    console.log(`🏠 Found ${homes.length} homes in database`);
    homes.forEach(home => {
      console.log(`  - ${home.name} (ID: ${home._id})`);
    });
    
    if (homes.length === 0) {
      console.log('❌ No homes found - create homes first!');
      return;
    }
    
    // Check what users exist
    const allUsers = await User.find({});
    console.log(`👥 Found ${allUsers.length} users in database`);
    
    // Check users with old home_id field
    const usersWithOldHomeId = await User.find({
      home_id: { $exists: true, $ne: null }
    });
    console.log(`📊 Users with old home_id field: ${usersWithOldHomeId.length}`);
    
    // Check users with homes array
    const usersWithHomesArray = await User.find({
      homes: { $exists: true, $ne: [] }
    });
    console.log(`📊 Users with homes array: ${usersWithHomesArray.length}`);
    
    // Check users assigned to specific homes
    const firstHome = homes[0];
    const usersInFirstHome = await User.find({
      'homes.home_id': firstHome._id,
      is_active: true
    });
    console.log(`📊 Users assigned to ${firstHome.name}: ${usersInFirstHome.length}`);
    
    if (usersInFirstHome.length === 0) {
      console.log('❌ No users assigned to homes - this is why AI solver fails!');
      
      // Try to fix by assigning users to the first home
      console.log('🔧 Attempting to fix by assigning users to first home...');
      
      const usersToUpdate = allUsers.filter(user => 
        user.role !== 'admin' && // Don't assign admins to specific homes
        user.is_active
      );
      
      console.log(`📊 Found ${usersToUpdate.length} users to assign to homes`);
      
      let updatedCount = 0;
      for (const user of usersToUpdate) {
        try {
          // Check if user already has homes
          if (user.homes && user.homes.length > 0) {
            console.log(`  ⚠️  User ${user.name} already has homes assigned, skipping...`);
            continue;
          }
          
          // Assign user to first home
          const result = await User.updateOne(
            { _id: user._id },
            { 
              $set: { 
                homes: [{
                  home_id: firstHome._id,
                  is_default: true
                }]
              }
            }
          );
          
          if (result.modifiedCount > 0) {
            console.log(`  ✅ Assigned ${user.name} to ${firstHome.name}`);
            updatedCount++;
          }
        } catch (error) {
          console.error(`  ❌ Error assigning ${user.name}:`, error.message);
        }
      }
      
      console.log(`\n📊 Fixed ${updatedCount} users`);
      
      // Verify the fix
      const usersInFirstHomeAfter = await User.find({
        'homes.home_id': firstHome._id,
        is_active: true
      });
      console.log(`📊 Users now assigned to ${firstHome.name}: ${usersInFirstHomeAfter.length}`);
      
      if (usersInFirstHomeAfter.length > 0) {
        console.log('🎉 Success! Users are now assigned to homes');
        console.log('💡 Try running the AI solver again');
      }
    } else {
      console.log('✅ Users are properly assigned to homes');
      console.log('💡 The issue might be elsewhere - check the AI solver logs');
    }
    
  } catch (error) {
    console.error('❌ Script failed:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    mongoose.connection.close();
  }
}

// Run the script
checkAndFixUserHomes();
