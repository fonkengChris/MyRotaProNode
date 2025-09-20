const mongoose = require('mongoose');

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
  start_time: {
    type: String,
    required: [true, 'Start time is required'],
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
  },
  end_time: {
    type: String,
    required: [true, 'End time is required'],
    match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
  },
  is_available: {
    type: Boolean,
    required: [true, 'Availability status is required']
  },
  preferred_shift_type: {
    type: String,
    enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'none'],
    default: null
  },
  notes: {
    type: String,
    maxlength: [500, 'Notes cannot exceed 500 characters']
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

// Compound index for user and date (unique combination)
availabilitySchema.index({ user_id: 1, date: 1 }, { unique: true });

// Additional indexes for performance
availabilitySchema.index({ date: 1 });
availabilitySchema.index({ is_available: 1 });
availabilitySchema.index({ preferred_shift_type: 1 });

// Virtual for availability info (excluding sensitive data)
availabilitySchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    user_id: this.user_id,
    date: this.date,
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
  if (!this.preferred_shift_type) {
    return true; // No preference means available for any
  }
  
  return this.preferred_shift_type === shiftType;
};

// Method to check if staff prefers specific time range
availabilitySchema.methods.prefersTimeRange = function(startTime, endTime) {
  if (!this.start_time || !this.end_time) {
    return true; // No time preference
  }
  
  const [prefStartHours, prefStartMinutes] = this.start_time.split(':').map(Number);
  const [prefEndHours, prefEndMinutes] = this.end_time.split(':').map(Number);
  const [shiftStartHours, shiftStartMinutes] = startTime.split(':').map(Number);
  const [shiftEndHours, shiftEndMinutes] = endTime.split(':').map(Number);
  
  const prefStartTotal = prefStartHours * 60 + prefStartMinutes;
  const prefEndTotal = prefEndHours * 60 + prefEndMinutes;
  const shiftStartTotal = shiftStartHours * 60 + shiftStartMinutes;
  const shiftEndTotal = shiftEndHours * 60 + shiftEndMinutes;
  
  // Handle overnight shifts
  let adjustedPrefEnd = prefEndTotal;
  let adjustedShiftEnd = shiftEndTotal;
  
  if (prefEndTotal < prefStartTotal) adjustedPrefEnd += 24 * 60;
  if (shiftEndTotal < shiftStartTotal) adjustedShiftEnd += 24 * 60;
  
  // Check if shift time overlaps with preferred time
  return shiftStartTotal >= prefStartTotal && shiftEndTotal <= adjustedPrefEnd;
};

// Method to get availability score for AI solver
availabilitySchema.methods.getAvailabilityScore = function(shiftType, startTime, endTime) {
  if (!this.is_available) return 0;
  
  let score = 100; // Base score
  
  // Reduce score if shift type doesn't match preference
  if (!this.prefersShiftType(shiftType)) {
    score -= 30;
  }
  
  // Reduce score if time doesn't match preference
  if (!this.prefersTimeRange(startTime, endTime)) {
    score -= 20;
  }
  
  return Math.max(score, 0);
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
