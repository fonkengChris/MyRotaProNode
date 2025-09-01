const mongoose = require('mongoose');
const User = require('../models/User');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function checkUserHomes() {
  try {
    console.log('🔍 Checking users and their home assignments...\n');
    
    const users = await User.find({}).select('name email role homes default_home_id');
    
    console.log(`📊 Found ${users.length} users:\n`);
    
    users.forEach((user, index) => {
      console.log(`${index + 1}. ${user.name} (${user.email})`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Homes: ${user.homes ? user.homes.length : 0}`);
      if (user.homes && user.homes.length > 0) {
        user.homes.forEach((home, homeIndex) => {
          console.log(`     ${homeIndex + 1}. Home ID: ${home.home_id} (Default: ${home.is_default})`);
        });
      }
      console.log(`   Default Home ID: ${user.default_home_id || 'None'}`);
      console.log('');
    });
    
    // Count users with homes
    const usersWithHomes = users.filter(user => user.homes && user.homes.length > 0);
    const usersWithoutHomes = users.filter(user => !user.homes || user.homes.length === 0);
    
    console.log('📈 Summary:');
    console.log(`   Users with homes: ${usersWithHomes.length}`);
    console.log(`   Users without homes: ${usersWithoutHomes.length}`);
    
    if (usersWithoutHomes.length > 0) {
      console.log('\n⚠️  Users without homes:');
      usersWithoutHomes.forEach(user => {
        console.log(`   - ${user.name} (${user.email}) - ${user.role}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error checking user homes:', error);
  } finally {
    mongoose.connection.close();
  }
}

checkUserHomes();
