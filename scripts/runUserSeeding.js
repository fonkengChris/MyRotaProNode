#!/usr/bin/env node

/**
 * Production User Seeding Script
 * 
 * This script creates users for the production database based on homes and services.
 * 
 * Requirements:
 * - 4 fulltime users per home (3 support_worker + 1 senior_staff)
 * - 2 parttime users per home
 * - 2 bank workers per home
 * - 2 cross-home workers per supported living home
 * - Outreach homes get only 1-2 staff (no senior_staff)
 * - All emails end with @myrotapro.com
 * - All passwords: passWord123#
 */

const { seedProductionUsers } = require('./seedProductionUsers');

async function main() {
  console.log('🚀 Starting Production User Seeding...\n');
  
  try {
    await seedProductionUsers();
    console.log('\n✅ User seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ User seeding failed:', error.message);
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
