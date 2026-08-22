const mongoose = require('mongoose');

/**
 * Overtime request raised when a staff member clocks out more than
 * OVERTIME_ELIGIBLE_MINUTES past their scheduled shift end. The requested
 * minutes only count toward paid hours once a manager/admin approves
 * (see routes/payroll.js reconciliation).
 */
const overtimeRequestSchema = new mongoose.Schema({
  shift_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift',
    required: [true, 'Shift ID is required']
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  home_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: [true, 'Home ID is required']
  },
  scheduled_end: {
    type: Date,
    required: [true, 'Scheduled end is required']
  },
  actual_clock_out: {
    type: Date,
    required: [true, 'Actual clock-out is required']
  },
  requested_minutes: {
    type: Number,
    required: [true, 'Requested minutes is required'],
    min: [1, 'Requested minutes must be at least 1']
  },
  reason: {
    type: String,
    maxlength: [500, 'Reason cannot exceed 500 characters']
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
overtimeRequestSchema.index({ user_id: 1 });
overtimeRequestSchema.index({ home_id: 1 });
overtimeRequestSchema.index({ shift_id: 1 });
overtimeRequestSchema.index({ status: 1 });
// Only one active request per (shift, user)
overtimeRequestSchema.index({ shift_id: 1, user_id: 1 }, { unique: true });

// Method to approve request
overtimeRequestSchema.methods.approve = function(approverId) {
  if (this.status !== 'pending') {
    throw new Error('Only pending requests can be approved');
  }

  this.status = 'approved';
  this.approved_by = approverId;
  this.approved_at = new Date();
  return this;
};

// Method to deny request
overtimeRequestSchema.methods.deny = function(denierId, reason) {
  if (this.status !== 'pending') {
    throw new Error('Only pending requests can be denied');
  }

  this.status = 'denied';
  this.approved_by = denierId;
  this.approved_at = new Date();
  this.denial_reason = reason;
  return this;
};

// Static: approved overtime minutes for a set of shift/user pairs, keyed by `${shiftId}:${userId}`
overtimeRequestSchema.statics.getApprovedMinutesMap = async function(shiftIds) {
  const rows = await this.find({ shift_id: { $in: shiftIds }, status: 'approved' });
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.shift_id.toString()}:${r.user_id.toString()}`, r.requested_minutes);
  }
  return map;
};

// Ensure virtual fields are serialized
overtimeRequestSchema.set('toJSON', { virtuals: true });
overtimeRequestSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('OvertimeRequest', overtimeRequestSchema);
