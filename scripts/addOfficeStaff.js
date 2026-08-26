const mongoose = require('mongoose');
const User = require('../models/User');
const Home = require('../models/Home');

// Use environment variable for MongoDB URI
const PRODUCTION_MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://chrisfonkeng:chrisfonkeng123@cluster0.8qj8x.mongodb.net/myrotapro?retryWrites=true&w=majority';

// Common password for all users
const COMMON_PASSWORD = 'passWord123#';

async function addOfficeStaff() {
  try {
    console.log('🏢 Adding Office Staff (Manager and Admin)...\n');
    
    // Connect to production database
    await mongoose.connect(PRODUCTION_MONGODB_URI);
    console.log('✅ Connected to production database');

    // Find the Office home
    const office = await Home.findOne({ name: 'Office' });
    if (!office) {
      console.error('❌ Office home not found!');
      return;
    }
    
    console.log(`🏢 Found Office: ${office.name} (ID: ${office._id})`);

    // Check if users already exist
    const existingAdmin = await User.findOne({ 
      email: 'admin.office@myrotapro.com' 
    });
    
    const existingManager = await User.findOne({ 
      email: 'manager.office@myrotapro.com' 
    });

    if (existingAdmin) {
      console.log('⚠️ Admin user already exists, skipping...');
    } else {
      // Create Admin user
      const adminUser = new User({
        name: 'Office Admin',
        email: 'admin.office@myrotapro.com',
        phone: '+441234567890',
        password: COMMON_PASSWORD,
        role: 'admin',
        type: 'fulltime',
        homes: [{
          home_id: office._id,
          is_default: true
        }],
        default_home_id: office._id,
        min_hours_per_week: 40,
        max_hours_per_week: 40,
        skills: ['specialist_care'],
        preferred_shift_types: ['morning', 'afternoon'],
        is_active: true
      });

      await adminUser.save();
      console.log('✅ Created Admin user: admin.office@myrotapro.com');
    }

    if (existingManager) {
      console.log('⚠️ Manager user already exists, skipping...');
    } else {
      // Create Manager user
      const managerUser = new User({
        name: 'Office Manager',
        email: 'manager.office@myrotapro.com',
        phone: '+441234567891',
        password: COMMON_PASSWORD,
        role: 'key_worker',
        type: 'fulltime',
        homes: [{
          home_id: office._id,
          is_default: true
        }],
        default_home_id: office._id,
        min_hours_per_week: 40,
        max_hours_per_week: 40,
        skills: ['specialist_care', 'social_support'],
        preferred_shift_types: ['morning', 'afternoon'],
        is_active: true
      });

      await managerUser.save();
      console.log('✅ Created Manager user: manager.office@myrotapro.com');
    }

    // Update the Office home to assign the manager
    if (!existingManager) {
      const managerUser = await User.findOne({ 
        email: 'manager.office@myrotapro.com' 
      });
      
      if (managerUser) {
        office.manager_id = managerUser._id;
        await office.save();
        console.log('✅ Assigned manager to Office home');
      }
    }

    // Verification
    console.log('\n📊 Verification:');
    const totalUsers = await User.countDocuments({ is_active: true });
    const adminUsers = await User.countDocuments({ role: 'admin', is_active: true });
    const managerUsers = await User.countDocuments({ role: 'key_worker', is_active: true });
    const officeUsers = await User.countDocuments({ 
      'homes.home_id': office._id, 
      is_active: true 
    });

    console.log(`👥 Total active users: ${totalUsers}`);
    console.log(`👑 Total admin users: ${adminUsers}`);
    console.log(`👔 Total manager users: ${managerUsers}`);
    console.log(`🏢 Total office users: ${officeUsers}`);

    // List office users
    const officeStaff = await User.find({ 
      'homes.home_id': office._id, 
      is_active: true 
    }).select('name email role type');

    console.log('\n🏢 Office Staff:');
    officeStaff.forEach(user => {
      console.log(`  ${user.name} (${user.email}) - ${user.role} (${user.type})`);
    });

    console.log('\n🎉 Office staff addition completed successfully!');
    console.log('🔑 Login credentials:');
    console.log('  Admin: admin.office@myrotapro.com / passWord123#');
    console.log('  Manager: manager.office@myrotapro.com / passWord123#');

  } catch (error) {
    console.error('❌ Error adding office staff:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
}

// Run the script if called directly
if (require.main === module) {
  addOfficeStaff();
}

module.exports = { addOfficeStaff };
