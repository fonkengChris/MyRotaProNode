const mongoose = require('mongoose');
const User = require('../models/User');

/**
 * Migration script to update existing users from home_id to homes array structure
 * This script should be run after updating the User model schema
 */
async function migrateUsersToNewSchema() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('Connected to MongoDB');

    // Find all users that still have the old home_id field
    const usersToMigrate = await User.find({ 
      $or: [
        { home_id: { $exists: true, $ne: null } },
        { homes: { $exists: false } }
      ]
    });

    console.log(`Found ${usersToMigrate.length} users to migrate`);

    let migratedCount = 0;
    let errors = [];

    for (const user of usersToMigrate) {
      try {
        // Initialize homes array if it doesn't exist
        if (!user.homes) {
          user.homes = [];
        }

        // If user has home_id, migrate it to homes array
        if (user.home_id) {
          // Check if home_id is already in homes array
          const homeExists = user.homes.some(home => 
            home.home_id.toString() === user.home_id.toString()
          );

          if (!homeExists) {
            user.homes.push({
              home_id: user.home_id,
              is_default: true
            });
            user.default_home_id = user.home_id;
          }

          // Remove the old home_id field
          user.home_id = undefined;
        }

        // Set default type if not set
        if (!user.type) {
          user.type = 'fulltime';
        }

        // Set default min_hours_per_week if not set
        if (!user.min_hours_per_week) {
          switch (user.type) {
            case 'fulltime':
              user.min_hours_per_week = 40;
              break;
            case 'parttime':
              user.min_hours_per_week = 20;
              break;
            case 'bank':
              user.min_hours_per_week = 0;
              break;
            default:
              user.min_hours_per_week = 40;
          }
        }

        // Save the updated user
        await user.save();
        migratedCount++;

        console.log(`✅ Migrated user: ${user.name} (${user.email})`);
      } catch (error) {
        console.error(`❌ Failed to migrate user ${user.email}:`, error.message);
        errors.push({ email: user.email, error: error.message });
      }
    }

    // Summary
    console.log('\n📊 MIGRATION SUMMARY:');
    console.log(`✅ Successfully migrated: ${migratedCount} users`);
    console.log(`❌ Failed to migrate: ${errors.length} users`);
    
    if (errors.length > 0) {
      console.log('\n❌ Migration Errors:');
      errors.forEach(error => {
        console.log(`  - ${error.email}: ${error.error}`);
      });
    }

    console.log('\n🔧 Migration completed!');

  } catch (error) {
    console.error('❌ Migration script failed:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

// Run the migration if this script is executed directly
if (require.main === module) {
  migrateUsersToNewSchema();
}

module.exports = { migrateUsersToNewSchema };
