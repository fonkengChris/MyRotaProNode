const mongoose = require('mongoose');
const User = require('../models/User');

// Use environment variable for MongoDB URI
const PRODUCTION_MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://chrisfonkeng:chrisfonkeng123@cluster0.8qj8x.mongodb.net/myrotapro?retryWrites=true&w=majority';

async function checkUsers() {
  try {
    console.log('🔍 Checking production database users...\n');
    
    // Connect to production database
    await mongoose.connect(PRODUCTION_MONGODB_URI);
    console.log('✅ Connected to production database');
    
    const totalUsers = await User.countDocuments({});
    const activeUsers = await User.countDocuments({ is_active: true });
    
    console.log(`📊 Total users in database: ${totalUsers}`);
    console.log(`✅ Active users: ${activeUsers}`);
    
    // Get a sample of users with their roles and homes
    const users = await User.find({ is_active: true }).select('name email role type homes').limit(10);
    console.log('\n👥 Sample users:');
    users.forEach(user => {
      const homeCount = user.homes ? user.homes.length : 0;
      console.log(`  - ${user.name} (${user.email}) - ${user.role} (${user.type}) - ${homeCount} homes`);
    });
    
    // Check users by role
    const roleCounts = await User.aggregate([
      { $match: { is_active: true } },
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);
    
    console.log('\n📈 Users by role:');
    roleCounts.forEach(role => {
      console.log(`  - ${role._id}: ${role.count} users`);
    });
    
    // Check users with no homes
    const usersWithNoHomes = await User.countDocuments({ 
      is_active: true, 
      $or: [
        { homes: { $exists: false } },
        { homes: { $size: 0 } }
      ]
    });
    
    console.log(`\n🏠 Users with no homes: ${usersWithNoHomes}`);
    
    // Check users by home
    const homeCounts = await User.aggregate([
      { $match: { is_active: true, homes: { $exists: true, $ne: [] } } },
      { $unwind: '$homes' },
      { $group: { _id: '$homes.home_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    console.log('\n🏠 Users by home:');
    homeCounts.forEach(home => {
      console.log(`  - Home ID ${home._id}: ${home.count} users`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
}

// Run the script if called directly
if (require.main === module) {
  checkUsers();
}

module.exports = { checkUsers };
