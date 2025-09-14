const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const User = require('../models/User');
const bcrypt = require('bcryptjs');

async function fixUserPassword() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    // Find user by email (include password field)
    const user = await User.findOne({ email: 'hope_house_bank_1@rcs.com' }).select('+password');
    
    if (!user) {
      console.log('❌ User not found');
      return;
    }
    
    console.log('👤 USER DETAILS:');
    console.log('=' .repeat(50));
    console.log('ID:', user._id);
    console.log('Name:', user.name);
    console.log('Email:', user.email);
    console.log('Current Password:', user.password || 'UNDEFINED');
    
    // Set the password to the standard test password
    const newPassword = 'passWord123';
    
    // Set the plain password - the pre-save middleware will hash it
    user.password = newPassword;
    await user.save();
    
    console.log('\n✅ PASSWORD UPDATED:');
    console.log('=' .repeat(50));
    console.log('New Password: passWord123');
    
    // Verify the password works using the model's method
    const isPasswordValid = await user.comparePassword(newPassword);
    console.log('Password Verification:', isPasswordValid ? '✅ Valid' : '❌ Invalid');
    
    console.log('\n💡 LOGIN INSTRUCTIONS:');
    console.log('=' .repeat(50));
    console.log('Email: hope_house_bank_1@rcs.com');
    console.log('Password: passWord123');
    console.log('\nThe user can now log in and should see available shifts!');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

fixUserPassword();
