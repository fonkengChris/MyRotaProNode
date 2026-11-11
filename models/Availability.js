const mongoose = require('mongoose');
const { AVAILABILITY_STATUSES, availabilityStatus } = require('../utils/availability');

const availabilitySchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  date: {
    type: String, // YYYY-MM-DD format
    required: [true, 'Date is required'],
    match: [/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format']
  },
  // available = any time; unavailable = not at all; partial = only start_time–end_time.
  status: {
    type: String,
    enum: { values: AVAILABILITY_STATUSES, message: 'Status must be available, unavailable or partial' }
  },
  // Only kept for partial days; cleared otherwise. An end at or before the start runs past midnight.
  start_time: {
    type: String,
    required: [function() { return this.status === 'partial'; }, 'Start time is required for partial availability'],
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
  },
  end_time: {
    type: String,
    required: [function() { return this.status === 'partial'; }, 'End time is required for partial availability'],
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
  },
  // Derived from status (false only when unavailable); kept for older readers.
  is_available: {
    type: Boolean
  },
  preferred_shift_type: {
    type: String,
    enum: ['morning', 'day', 'afternoon', 'evening', 'night-wake', 'night-sleep', 'night', 'overtime', 'long_day', 'one_to_one', 'none'],
    // 'none' = no preference. Blank/null (the form's "No preference") are stored as 'none'
    // rather than failing the enum check.
    default: 'none',
    set: (v) => (v === '' || v === null || v === undefined ? 'none' : v)
  },
  notes: {
    type: String,
    maxlength: [500, 'Notes cannot exceed 500 characters']
  },
  // The person's own entry for this day, set aside while approved leave covers it and put back
  // if the leave is cancelled (see timeOffService). Never set from the API.
  pre_leave: {
    type: new mongoose.Schema({
      status: String,
      start_time: String,
      end_time: String,
      is_available: Boolean,
      preferred_shift_type: String,
      notes: String
    }, { _id: false }),
    default: undefined
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

// Older clients send only is_available; status wins when both are given.
availabilitySchema.pre('validate', function() {
  if (!this.status) this.status = availabilityStatus(this);
  this.is_available = this.status !== 'unavailable';
  if (this.status !== 'partial') {
    this.start_time = undefined;
    this.end_time = undefined;
  } else if (this.start_time && this.start_time === this.end_time) {
    this.invalidate('end_time', 'End time must differ from start time');
  }
});

// Compound index for user and date (unique combination)
availabilitySchema.index({ user_id: 1, date: 1 }, { unique: true });

// Additional indexes for performance
availabilitySchema.index({ date: 1 });
availabilitySchema.index({ status: 1 });
availabilitySchema.index({ preferred_shift_type: 1 });

// Virtual for availability info (excluding sensitive data)
availabilitySchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    user_id: this.user_id,
    date: this.date,
    status: availabilityStatus(this),
    start_time: this.start_time,
    end_time: this.end_time,
    is_available: this.is_available,
    preferred_shift_type: this.preferred_shift_type,
    notes: this.notes,
    submitted_at: this.submitted_at
  };
});

// Method to check if staff prefers specific shift type
availabilitySchema.methods.prefersShiftType = function(shiftType) {
  if (!this.preferred_shift_type || this.preferred_shift_type === 'none') {
    return true; // No preference means available for any
  }
  
  return this.preferred_shift_type === shiftType;
};

// Static method to get availability for multiple users on a date
availabilitySchema.statics.getAvailabilityForDate = function(date, userIds) {
  return this.find({
    date: date,
    user_id: { $in: userIds }
  });
};

// Static method to get availability for a user in a date range
availabilitySchema.statics.getUserAvailabilityRange = function(userId, startDate, endDate) {
  return this.find({
    user_id: userId,
    date: {
      $gte: startDate,
      $lte: endDate
    }
  }).sort({ date: 1 });
};

// Ensure virtual fields are serialized
availabilitySchema.set('toJSON', { virtuals: true });
availabilitySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Availability', availabilitySchema);
