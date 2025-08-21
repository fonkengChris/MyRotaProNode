const mongoose = require('mongoose');

const timeOffRequestSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  start_date: {
    type: String, // YYYY-MM-DD format
    required: [true, 'Start date is required'],
    match: [/^\d{4}-\d{2}-\d{2}$/, 'Start date must be in YYYY-MM-DD format']
  },
  end_date: {
    type: String, // YYYY-MM-DD format
    required: [true, 'End date is required'],
    match: [/^\d{4}-\d{2}-\d{2}$/, 'End date must be in YYYY-MM-DD format']
  },
  reason: {
    type: String,
    required: [true, 'Reason is required'],
    maxlength: [500, 'Reason cannot exceed 500 characters']
  },
  request_type: {
    type: String,
    enum: ['annual_leave', 'sick_leave', 'personal_leave', 'bereavement', 'other'],
    required: [true, 'Request type is required']
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'denied'],
    default: 'pending'
  },
  approved_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approved_at: {
    type: Date
  },
  denial_reason: {
    type: String,
    maxlength: [500, 'Denial reason cannot exceed 500 characters']
  },
  is_urgent: {
    type: Boolean,
    default: false
  },
  submitted_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'submitted_at', updatedAt: 'updated_at' }
});

// Indexes for performance
timeOffRequestSchema.index({ user_id: 1 });
timeOffRequestSchema.index({ start_date: 1 });
timeOffRequestSchema.index({ end_date: 1 });
timeOffRequestSchema.index({ status: 1 });
timeOffRequestSchema.index({ request_type: 1 });

// Virtual for time off info (excluding sensitive data)
timeOffRequestSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    user_id: this.user_id,
    start_date: this.start_date,
    end_date: this.end_date,
    reason: this.reason,
    request_type: this.request_type,
    status: this.status,
    approved_by: this.approved_by,
    approved_at: this.approved_at,
    denial_reason: this.denial_reason,
    is_urgent: this.is_urgent,
    submitted_at: this.submitted_at
  };
});

// Virtual for duration in days
timeOffRequestSchema.virtual('duration_days').get(function() {
  if (!this.start_date || !this.end_date) return 0;
  
  const start = new Date(this.start_date);
  const end = new Date(this.end_date);
  
  const timeDiff = end.getTime() - start.getTime();
  const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
  
  return daysDiff + 1; // Include both start and end dates
});

// Method to approve request
timeOffRequestSchema.methods.approve = function(approverId) {
  if (this.status !== 'pending') {
    throw new Error('Only pending requests can be approved');
  }
  
  this.status = 'approved';
  this.approved_by = approverId;
  this.approved_at = new Date();
  return this;
};

// Method to deny request
timeOffRequestSchema.methods.deny = function(denierId, reason) {
  if (this.status !== 'pending') {
    throw new Error('Only pending requests can be denied');
  }
  
  this.status = 'denied';
  this.approved_by = denierId;
  this.approved_at = new Date();
  this.denial_reason = reason;
  return this;
};

// Method to check if request overlaps with dates
timeOffRequestSchema.methods.overlapsWithDates = function(startDate, endDate) {
  const requestStart = new Date(this.start_date);
  const requestEnd = new Date(this.end_date);
  const checkStart = new Date(startDate);
  const checkEnd = new Date(endDate);
  
  return requestStart <= checkEnd && requestEnd >= checkStart;
};

// Method to check if request is active (approved and within date range)
timeOffRequestSchema.methods.isActive = function(checkDate) {
  if (this.status !== 'approved') return false;
  
  const check = new Date(checkDate);
  const start = new Date(this.start_date);
  const end = new Date(this.end_date);
  
  return check >= start && check <= end;
};

// Static method to get active time off requests for a date range
timeOffRequestSchema.statics.getActiveRequestsForDateRange = function(startDate, endDate, userIds = null) {
  const query = {
    status: 'approved',
    start_date: { $lte: endDate },
    end_date: { $gte: startDate }
  };
  
  if (userIds) {
    query.user_id = { $in: userIds };
  }
  
  return this.find(query);
};

// Static method to get pending requests for approval
timeOffRequestSchema.statics.getPendingRequests = function(approverRole, approverHomeId = null) {
  const query = { status: 'pending' };
  
  // If approver is not admin, filter by home
  if (approverRole !== 'admin' && approverHomeId) {
    // This would need to be populated with user's home_id
    // For now, we'll return all pending requests
  }
  
  return this.find(query).populate('user_id', 'name email home_id');
};

// Ensure virtual fields are serialized
timeOffRequestSchema.set('toJSON', { virtuals: true });
timeOffRequestSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('TimeOffRequest', timeOffRequestSchema);
