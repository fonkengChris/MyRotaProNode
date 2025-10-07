const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

// Use environment variable for MongoDB URI
const PRODUCTION_MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://chrisfonkeng:chrisfonkeng123@cluster0.8qj8x.mongodb.net/myrotapro?retryWrites=true&w=majority';

// Common password for all users
const COMMON_PASSWORD = 'passWord123#';

async function fixPasswordHashing() {
  try {
    console.log('🔐 Fixing password hashing for all users...\n');
    
    // Connect to production database
    await mongoose.connect(PRODUCTION_MONGODB_URI);
    console.log('✅ Connected to production database');

    // Find all users with unhashed passwords
    const users = await User.find({ is_active: true }).select('+password');
    console.log(`📊 Found ${users.length} active users`);

    let fixedCount = 0;
    let alreadyHashedCount = 0;

    for (const user of users) {
      // Check if password is already hashed (bcrypt hashes start with $2a$)
      const isAlreadyHashed = user.password && user.password.startsWith('$2a$');
      
      if (isAlreadyHashed) {
        alreadyHashedCount++;
        console.log(`✅ ${user.email}: Password already hashed`);
        continue;
      }

      // Hash the password
      const hashedPassword = await bcrypt.hash(COMMON_PASSWORD, 12);
      
      // Update the user's password
      await User.findByIdAndUpdate(user._id, { 
        password: hashedPassword 
      });
      
      fixedCount++;
      console.log(`🔧 Fixed: ${user.email}`);
    }

    // Verification - test a few users
    console.log('\n🧪 Testing password verification...');
    const testUsers = users.slice(0, 3);
    
    for (const user of testUsers) {
      // Get the updated user with hashed password
      const updatedUser = await User.findById(user._id).select('+password');
      const isValid = await updatedUser.comparePassword(COMMON_PASSWORD);
      console.log(`🔐 ${updatedUser.email}: ${isValid ? '✅ Valid' : '❌ Invalid'}`);
    }

    console.log('\n📊 SUMMARY:');
    console.log(`🔧 Users with fixed passwords: ${fixedCount}`);
    console.log(`✅ Users already hashed: ${alreadyHashedCount}`);
    console.log(`👥 Total users processed: ${users.length}`);
    console.log(`🔑 Password used: ${COMMON_PASSWORD}`);

    console.log('\n🎉 Password hashing fix completed successfully!');

  } catch (error) {
    console.error('❌ Error fixing password hashing:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
}

// Run the script if called directly
if (require.main === module) {
  fixPasswordHashing();
}

module.exports = { fixPasswordHashing };
