#!/usr/bin/env node

/**
 * Office Staff Addition Script
 * 
 * This script adds a manager and admin who work in the office.
 */

const { addOfficeStaff } = require('./addOfficeStaff');

async function main() {
  console.log('🚀 Adding Office Staff (Manager and Admin)...\n');
  
  try {
    await addOfficeStaff();
    console.log('\n✅ Office staff addition completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Office staff addition failed:', error.message);
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
