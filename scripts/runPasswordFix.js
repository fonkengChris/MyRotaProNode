#!/usr/bin/env node

/**
 * Password Hashing Fix Script
 * 
 * This script fixes password hashing for all users in the database.
 * It ensures all passwords are properly hashed using bcrypt.
 */

const { fixPasswordHashing } = require('./fixPasswordHashing');

async function main() {
  console.log('🚀 Fixing Password Hashing for All Users...\n');
  
  try {
    await fixPasswordHashing();
    console.log('\n✅ Password hashing fix completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Password hashing fix failed:', error.message);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

// Run the script
main();
