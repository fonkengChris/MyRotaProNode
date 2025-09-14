const mongoose = require('mongoose');

const shiftSwapSchema = new mongoose.Schema({
  // The shift that the requester wants to give up
  requester_shift_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift',
    required: [true, 'Requester shift ID is required']
  },
  // The shift that the requester wants to receive
  target_shift_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift',
    required: [true, 'Target shift ID is required']
  },
  // User who initiated the swap request
  requester_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Requester ID is required']
  },
  // User who needs to approve the swap (owner of target shift)
  target_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Target user ID is required']
  },
  // Status of the swap request
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'completed'],
    default: 'pending'
  },
  // Message from requester
  requester_message: {
    type: String,
    maxlength: [500, 'Message cannot exceed 500 characters']
  },
  // Response message from target user
  response_message: {
    type: String,
    maxlength: [500, 'Response message cannot exceed 500 characters']
  },
  // Conflict check results
  conflict_check: {
    has_conflict: {
      type: Boolean,
      default: false
    },
    conflict_details: [{
      type: String,
      conflict_type: String,
      message: String
    }]
  },
  // Timestamps for tracking
  requested_at: {
    type: Date,
    default: Date.now
  },
  responded_at: {
    type: Date
  },
  completed_at: {
    type: Date
  },
  // Expiration time for the request (default 7 days)
  expires_at: {
    type: Date,
    default: function() {
      const expiration = new Date();
      expiration.setDate(expiration.getDate() + 7);
      return expiration;
    }
  },
  // Additional metadata
  home_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: [true, 'Home ID is required']
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes for performance
shiftSwapSchema.index({ requester_id: 1 });
shiftSwapSchema.index({ target_user_id: 1 });
shiftSwapSchema.index({ status: 1 });
shiftSwapSchema.index({ home_id: 1 });
shiftSwapSchema.index({ expires_at: 1 });
shiftSwapSchema.index({ requester_shift_id: 1, target_shift_id: 1 });

// Virtual for checking if request is expired
shiftSwapSchema.virtual('isExpired').get(function() {
  return new Date() > this.expires_at;
});

// Virtual for checking if request is active (pending and not expired)
shiftSwapSchema.virtual('isActive').get(function() {
  return this.status === 'pending' && !this.isExpired;
});

// Method to approve the swap
shiftSwapSchema.methods.approve = function(responseMessage = '') {
  if (this.status !== 'pending') {
    throw new Error('Only pending swaps can be approved');
  }
  
  if (this.isExpired) {
    throw new Error('Cannot approve expired swap request');
  }
  
  this.status = 'approved';
  this.response_message = responseMessage;
  this.responded_at = new Date();
  return this;
};

// Method to reject the swap
shiftSwapSchema.methods.reject = function(responseMessage = '') {
  if (this.status !== 'pending') {
    throw new Error('Only pending swaps can be rejected');
  }
  
  this.status = 'rejected';
  this.response_message = responseMessage;
  this.responded_at = new Date();
  return this;
};

// Method to cancel the swap (by requester)
shiftSwapSchema.methods.cancel = function() {
  if (this.status !== 'pending') {
    throw new Error('Only pending swaps can be cancelled');
  }
  
  this.status = 'cancelled';
  this.responded_at = new Date();
  return this;
};

// Method to mark as completed
shiftSwapSchema.methods.complete = function() {
  if (this.status !== 'approved') {
    throw new Error('Only approved swaps can be completed');
  }
  
  this.status = 'completed';
  this.completed_at = new Date();
  return this;
};

// Static method to find active swaps for a user
shiftSwapSchema.statics.findActiveSwapsForUser = function(userId) {
  return this.find({
    $or: [
      { requester_id: userId },
      { target_user_id: userId }
    ],
    status: 'pending',
    expires_at: { $gt: new Date() }
  }).populate('requester_shift_id target_shift_id requester_id target_user_id home_id');
};

// Static method to find pending swaps for a user (where they need to respond)
shiftSwapSchema.statics.findPendingSwapsForUser = function(userId) {
  return this.find({
    target_user_id: userId,
    status: 'pending',
    expires_at: { $gt: new Date() }
  }).populate('requester_shift_id target_shift_id requester_id home_id');
};

// Static method to find swap history for a user
shiftSwapSchema.statics.findSwapHistoryForUser = function(userId, limit = 50) {
  return this.find({
    $or: [
      { requester_id: userId },
      { target_user_id: userId }
    ],
    status: { $in: ['approved', 'rejected', 'cancelled', 'completed'] }
  })
  .populate('requester_shift_id target_shift_id requester_id target_user_id home_id')
  .sort({ updated_at: -1 })
  .limit(limit);
};

// Ensure virtual fields are serialized
shiftSwapSchema.set('toJSON', { virtuals: true });
shiftSwapSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ShiftSwap', shiftSwapSchema);
