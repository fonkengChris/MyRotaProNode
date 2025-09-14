const mongoose = require('mongoose');
require('dotenv').config({ path: '../env.example' });

const Shift = require('../models/Shift');
const Home = require('../models/Home');
const Service = require('../models/Service');

async function checkCurrentWeekShifts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    console.log('✅ Connected to MongoDB\n');

    // Get current week dates
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() + 1); // Monday
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6); // Sunday
    
    const startDate = startOfWeek.toISOString().split('T')[0];
    const endDate = endOfWeek.toISOString().split('T')[0];
    
    console.log('📅 CURRENT WEEK ANALYSIS:');
    console.log('=' .repeat(50));
    console.log('Today:', now.toISOString().split('T')[0]);
    console.log('Week Start:', startDate);
    console.log('Week End:', endDate);
    
    // Get all shifts for current week
    const allShifts = await Shift.find({
      date: { $gte: startDate, $lte: endDate },
      is_active: true
    }).populate('home_id', 'name').populate('service_id', 'name');
    
    console.log(`\n📊 TOTAL SHIFTS FOR CURRENT WEEK: ${allShifts.length}`);
    
    if (allShifts.length === 0) {
      console.log('❌ No shifts exist for the current week!');
      console.log('\n💡 SOLUTION: Create shifts for the current week');
      console.log('You can:');
      console.log('1. Use the Rota Editor to create shifts');
      console.log('2. Run the AI Solver to generate shifts');
      console.log('3. Create weekly schedules first');
      return;
    }
    
    // Group by home
    const shiftsByHome = {};
    allShifts.forEach(shift => {
      const homeName = shift.home_id?.name || 'Unknown';
      if (!shiftsByHome[homeName]) {
        shiftsByHome[homeName] = [];
      }
      shiftsByHome[homeName].push(shift);
    });
    
    console.log('\n🏠 SHIFTS BY HOME:');
    console.log('=' .repeat(50));
    
    Object.keys(shiftsByHome).forEach(homeName => {
      const shifts = shiftsByHome[homeName];
      console.log(`\n${homeName}: ${shifts.length} shifts`);
      
      shifts.forEach(shift => {
        const assignedCount = shift.assigned_staff?.length || 0;
        const requiredCount = shift.required_staff_count || 1;
        const status = assignedCount >= requiredCount ? '✅ Full' : '⚠️  Needs Staff';
        
        console.log(`  - ${shift.date} ${shift.start_time}-${shift.end_time} (${shift.shift_type}) - ${assignedCount}/${requiredCount} ${status}`);
      });
    });
    
    // Check specifically for Hope House and Compassion House shifts
    const userHomes = ['68a634e9f2c2d29016fce6c4', '68a63f6ea1391dad179f404a'];
    const userShifts = allShifts.filter(shift => 
      userHomes.includes(shift.home_id._id.toString())
    );
    
    console.log(`\n👤 SHIFTS FOR HOPE BANK 1'S HOMES: ${userShifts.length}`);
    console.log('=' .repeat(50));
    
    if (userShifts.length === 0) {
      console.log('❌ No shifts exist for Hope House or Compassion House this week');
      console.log('\n💡 SOLUTION: Create shifts for these homes');
    } else {
      userShifts.forEach(shift => {
        const assignedCount = shift.assigned_staff?.length || 0;
        const requiredCount = shift.required_staff_count || 1;
        const status = assignedCount >= requiredCount ? '✅ Full' : '⚠️  Available';
        
        console.log(`  - ${shift.home_id.name}: ${shift.date} ${shift.start_time}-${shift.end_time} (${shift.shift_type}) - ${assignedCount}/${requiredCount} ${status}`);
      });
    }
    
    // Check what dates have shifts
    const datesWithShifts = [...new Set(allShifts.map(shift => shift.date))].sort();
    console.log(`\n📅 DATES WITH SHIFTS: ${datesWithShifts.length} days`);
    console.log('=' .repeat(50));
    datesWithShifts.forEach(date => {
      const dayShifts = allShifts.filter(shift => shift.date === date);
      console.log(`  ${date}: ${dayShifts.length} shifts`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

checkCurrentWeekShifts();
