const mongoose = require('mongoose');
const ShiftSwap = require('../models/ShiftSwap');
const Shift = require('../models/Shift');
const User = require('../models/User');
const Home = require('../models/Home');
require('dotenv').config();

async function manageSwapRequests() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro');
    
    console.log('=== SHIFT SWAP REQUEST MANAGEMENT ===\n');
    
    // Get all existing swap requests
    const existingSwaps = await ShiftSwap.find({})
      .populate('requester_shift_id', 'date start_time end_time shift_type')
      .populate('target_shift_id', 'date start_time end_time shift_type')
      .populate('requester_id', 'name role')
      .populate('target_user_id', 'name role')
      .populate('home_id', 'name')
      .sort({ created_at: -1 });
    
    console.log(`Found ${existingSwaps.length} existing swap requests:\n`);
    
    if (existingSwaps.length === 0) {
      console.log('No existing swap requests found. You can proceed with testing.');
      return;
    }
    
    // Display existing swaps
    existingSwaps.forEach((swap, index) => {
      console.log(`${index + 1}. Swap ID: ${swap._id}`);
      console.log(`   Status: ${swap.status}`);
      console.log(`   Requester: ${swap.requester_id.name} (${swap.requester_id.role})`);
      console.log(`   Target User: ${swap.target_user_id.name} (${swap.target_user_id.role})`);
      console.log(`   Requester Shift: ${swap.requester_shift_id.date} ${swap.requester_shift_id.start_time}-${swap.requester_shift_id.end_time} (${swap.requester_shift_id.shift_type})`);
      console.log(`   Target Shift: ${swap.target_shift_id.date} ${swap.target_shift_id.start_time}-${swap.target_shift_id.end_time} (${swap.target_shift_id.shift_type})`);
      console.log(`   Home: ${swap.home_id.name}`);
      console.log(`   Created: ${swap.created_at}`);
      console.log(`   Expires: ${swap.expires_at}`);
      console.log(`   Has Conflicts: ${swap.conflict_check.has_conflict}`);
      if (swap.conflict_check.has_conflict) {
        console.log(`   Conflict Details:`);
        swap.conflict_check.conflict_details.forEach(conflict => {
          console.log(`     - ${conflict.type}: ${conflict.message}`);
        });
      }
      console.log('');
    });
    
    // Check if the specific shifts from your test are involved
    const testShift1 = '68b737c85d3a5a3d316fc8c6';
    const testShift2 = '68b737c85d3a5a3d316fc8cc';
    
    const conflictingSwaps = existingSwaps.filter(swap => 
      swap.requester_shift_id._id.toString() === testShift1 ||
      swap.requester_shift_id._id.toString() === testShift2 ||
      swap.target_shift_id._id.toString() === testShift1 ||
      swap.target_shift_id._id.toString() === testShift2
    );
    
    if (conflictingSwaps.length > 0) {
      console.log('🚨 CONFLICTING SWAPS FOUND:');
      console.log('The shifts you\'re trying to test are already involved in these swap requests:\n');
      
      conflictingSwaps.forEach((swap, index) => {
        console.log(`${index + 1}. Swap ID: ${swap._id} (Status: ${swap.status})`);
        console.log(`   This swap involves one or both of your test shifts.`);
      });
      
      console.log('\n💡 SOLUTIONS:');
      console.log('1. Wait for existing swaps to be resolved (approved/rejected/cancelled)');
      console.log('2. Use different shifts for testing');
      console.log('3. Cancel the existing swap requests (see options below)');
    }
    
    // Provide management options
    console.log('\n🔧 MANAGEMENT OPTIONS:');
    console.log('1. View all pending swaps');
    console.log('2. Cancel all pending swaps (for testing)');
    console.log('3. Cancel specific swap by ID');
    console.log('4. Find alternative shifts for testing');
    
    // Show pending swaps count
    const pendingSwaps = existingSwaps.filter(swap => swap.status === 'pending');
    console.log(`\nPending swaps: ${pendingSwaps.length}`);
    
    if (pendingSwaps.length > 0) {
      console.log('\nTo cancel all pending swaps for testing, run:');
      console.log('node scripts/manageSwapRequests.js --cancel-all');
      
      console.log('\nTo cancel a specific swap, run:');
      console.log('node scripts/manageSwapRequests.js --cancel <swap_id>');
    }
    
    // Check command line arguments
    const args = process.argv.slice(2);
    
    if (args.includes('--cancel-all')) {
      console.log('\n🗑️  Cancelling all pending swaps...');
      const result = await ShiftSwap.updateMany(
        { status: 'pending' },
        { 
          status: 'cancelled',
          responded_at: new Date(),
          response_message: 'Cancelled for testing purposes'
        }
      );
      console.log(`✅ Cancelled ${result.modifiedCount} pending swaps.`);
    }
    
    if (args.includes('--cancel') && args[args.indexOf('--cancel') + 1]) {
      const swapId = args[args.indexOf('--cancel') + 1];
      console.log(`\n🗑️  Cancelling swap ${swapId}...`);
      const result = await ShiftSwap.findByIdAndUpdate(
        swapId,
        { 
          status: 'cancelled',
          responded_at: new Date(),
          response_message: 'Cancelled for testing purposes'
        }
      );
      if (result) {
        console.log(`✅ Cancelled swap ${swapId}.`);
      } else {
        console.log(`❌ Swap ${swapId} not found.`);
      }
    }
    
    if (args.includes('--find-alternatives')) {
      console.log('\n🔍 Finding alternative shifts for testing...');
      
      // Get shifts that are not involved in any swap requests
      const involvedShiftIds = existingSwaps.map(swap => [
        swap.requester_shift_id._id.toString(),
        swap.target_shift_id._id.toString()
      ]).flat();
      
      const availableShifts = await Shift.find({
        _id: { $nin: involvedShiftIds },
        date: { $gte: '2025-09-08', $lte: '2025-09-14' },
        is_active: true,
        'assigned_staff.0': { $exists: true } // Has at least one assigned staff
      })
      .populate('home_id', 'name')
      .populate('assigned_staff.user_id', 'name role')
      .limit(10);
      
      console.log(`\nFound ${availableShifts.length} shifts available for testing:`);
      availableShifts.forEach((shift, index) => {
        console.log(`${index + 1}. ${shift.home_id.name} - ${shift.date} ${shift.start_time}-${shift.end_time}`);
        console.log(`   Shift ID: ${shift._id}`);
        console.log(`   Assigned: ${shift.assigned_staff.map(a => a.user_id.name).join(', ')}`);
      });
    }
    
  } catch (error) {
    console.error('Error managing swap requests:', error);
  } finally {
    await mongoose.disconnect();
  }
}

manageSwapRequests();
