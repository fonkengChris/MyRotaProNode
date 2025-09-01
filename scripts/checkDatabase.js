const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

async function checkDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    
    // Check homes
    const homes = await db.collection('homes').find({}).toArray();
    console.log('\n🏠 Homes in database:');
    if (homes.length === 0) {
      console.log('  No homes found');
    } else {
      homes.forEach(home => {
        console.log(`  - ${home._id}: ${home.name || 'Unnamed'}`);
      });
    }

    // Check users
    const users = await db.collection('users').find({}).toArray();
    console.log('\n👥 Users in database:');
    if (users.length === 0) {
      console.log('  No users found');
    } else {
      users.forEach(user => {
        const homeIds = user.homes && user.homes.length > 0 
          ? user.homes.map(h => h.home_id).join(', ') 
          : 'No homes';
        console.log(`  - ${user._id}: ${user.name || 'Unnamed'} (homes: ${homeIds})`);
      });
    }

    // Check if the specific home ID exists
    const targetHomeId = '68a639210af00a5a4f1bf953';
    const targetHome = await db.collection('homes').findOne({ _id: new mongoose.Types.ObjectId(targetHomeId) });
    console.log(`\n🔍 Target home ID ${targetHomeId}:`);
    if (targetHome) {
      console.log(`  ✅ Found: ${targetHome.name || 'Unnamed'}`);
    } else {
      console.log(`  ❌ Not found`);
    }

    // Check users for this home
    const usersForHome = await db.collection('users').find({
      'homes.home_id': new mongoose.Types.ObjectId(targetHomeId)
    }).toArray();
    console.log(`\n👥 Users assigned to home ${targetHomeId}:`);
    if (usersForHome.length === 0) {
      console.log('  No users assigned to this home');
    } else {
      usersForHome.forEach(user => {
        console.log(`  - ${user.name || 'Unnamed'} (${user._id})`);
      });
    }

  } catch (error) {
    console.error('❌ Script error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 MongoDB connection closed');
  }
}

checkDatabase().catch(console.error);
