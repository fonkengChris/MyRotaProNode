const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

async function createAvailabilityForWeek() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    
    // Get all users assigned to the home
    const homeIdObj = new mongoose.Types.ObjectId('68a639210af00a5a4f1bf953');
    
    const users = await db.collection('users').find({
      'homes.home_id': homeIdObj
    }).toArray();

    console.log(`📊 Found ${users.length} users for home 68a639210af00a5a4f1bf953`);

    if (users.length === 0) {
      console.log('No users found for this home');
      return;
    }

    // Target week dates
    const weekDates = [
      '2025-08-25', '2025-08-26', '2025-08-27', '2025-08-28', 
      '2025-08-29', '2025-08-30', '2025-08-31'
    ];

    let createdCount = 0;
    let errors = [];

    for (const user of users) {
      for (const date of weekDates) {
        try {
          // Check if availability already exists
          const existingAvailability = await db.collection('availabilities').findOne({
            user_id: user._id,
            date: date
          });

          if (existingAvailability) {
            console.log(`   ⚠️  Availability already exists for ${user.name} on ${date}`);
            continue;
          }

          // Create availability record
          const availabilityData = {
            user_id: user._id,
            date: date,
            is_available: true,
            start_time: '06:00',
            end_time: '22:00',
            preferred_shift_types: ['morning', 'afternoon', 'night'],
            notes: 'Auto-generated for AI testing',
            submitted_at: new Date(),
            updated_at: new Date()
          };

          const result = await db.collection('availabilities').insertOne(availabilityData);

          if (result.insertedId) {
            console.log(`   ✅ Created availability for ${user.name} on ${date}`);
            createdCount++;
          } else {
            console.log(`   ⚠️  Failed to create availability for ${user.name} on ${date}`);
          }

        } catch (error) {
          console.error(`   ❌ Error creating availability for ${user.name} on ${date}:`, error.message);
          errors.push({ userId: user._id, name: user.name, date, error: error.message });
        }
      }
    }

    console.log('\n📊 SUMMARY:');
    console.log(`✅ Successfully created: ${createdCount} availability records`);
    console.log(`❌ Failed to create: ${errors.length} records`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach(error => {
        console.log(`  - ${error.name} on ${error.date}: ${error.error}`);
      });
    }

    // Verify the data
    console.log('\n🔍 Verifying availability data...');
    const totalAvailability = await db.collection('availabilities').countDocuments({
      date: { $in: weekDates }
    });
    console.log(`Total availability records for target week: ${totalAvailability}`);

  } catch (error) {
    console.error('❌ Script error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  }
}

createAvailabilityForWeek().catch(console.error);
