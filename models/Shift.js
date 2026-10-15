const mongoose = require('mongoose');
const { getShiftHourBreakdown } = require('../utils/shiftHours');

const shiftSchema = new mongoose.Schema({
  home_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: [true, 'Home ID is required']
  },
  service_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: [true, 'Service ID is required']
  },
  date: {
    type: String,
    required: [true, 'Shift date is required'],
    match: [/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'],
    set: function(val) {
      // Ensure consistent date format
      if (typeof val === 'string') {
        return val; // Store as-is
      } else if (val instanceof Date) {
        // Convert Date object to YYYY-MM-DD string
        const year = val.getFullYear();
        const month = String(val.getMonth() + 1).padStart(2, '0');
        const day = String(val.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      return val;
    }
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
  // night-wake + legacy night: full span = paid hours. night-sleep: 8h sleep-in + remainder paid (see utils/shiftHours).
  shift_type: {
    type: String,
    enum: ['morning', 'day', 'afternoon', 'evening', 'night-wake', 'night-sleep', 'night', 'overtime', 'long_day', 'split', 'one_to_one'],
    required: [true, 'Shift type is required']
  },
  // Set only on `one_to_one` shifts: the service user this 1-to-1 support is for.
  // Background (all other) shifts never carry one. See utils/oneToOne.js.
  service_user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ServiceUser',
    default: null
  },
  required_staff_count: {
    type: Number,
    required: [true, 'Required staff count is required'],
    min: [1, 'Required staff count must be at least 1'],
    max: [50, 'Required staff count cannot exceed 50']
  },
  assigned_staff: [{
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    status: {
      type: String,
      enum: ['assigned', 'pending', 'swapped', 'declined'],
      default: 'assigned'
    },
    assigned_at: {
      type: Date,
      default: Date.now
    },
    note: String,
    // Rest-exception review: set to 'pending' when a support worker self-selects a shift
    // that breaks only the <8h rest rule (assign-now, flag-for-review). An admin then
    // 'confirmed's it or removes the assignment. 'none' for normal assignments.
    rest_exception_status: {
      type: String,
      enum: ['none', 'pending', 'confirmed'],
      default: 'none'
    },
    // Attendance tracking (clock-in / clock-out)
    clock_in_time: {
      type: Date,
      default: null
    },
    clock_out_time: {
      type: Date,
      default: null
    },
    attendance_status: {
      type: String,
      enum: ['not_started', 'clocked_in', 'clocked_out', 'missed'],
      default: 'not_started'
    },
    // Idempotency stamps for the attendance scheduler (see services/attendanceScheduler.js)
    clock_in_reminder_sent_at: {
      type: Date,
      default: null
    },
    clock_in_escalation_sent_at: {
      type: Date,
      default: null
    },
    // Set when admins were told the staff member hadn't clocked out after the grace period.
    clock_out_escalation_sent_at: {
      type: Date,
      default: null
    }
  }],
  is_urgent: {
    type: Boolean,
    default: false
  },
  notes: {
    type: String,
    maxlength: [500, 'Notes cannot exceed 500 characters']
  },
  is_active: {
    type: Boolean,
    default: true
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
shiftSchema.index({ home_id: 1 });
shiftSchema.index({ service_id: 1 });
shiftSchema.index({ date: 1 });
shiftSchema.index({ 'assigned_staff.user_id': 1 });
// Supports the admin rest-exception review queue (pending/confirmed flagged assignments).
shiftSchema.index({ 'assigned_staff.rest_exception_status': 1 });
shiftSchema.index({ is_active: 1 });
shiftSchema.index({ service_user_id: 1, date: 1 });
// Supports the attendance scheduler scan (today's shifts still awaiting clock-in).
// Keyed on clock_in_time (null) so docs predating the attendance fields still match.
shiftSchema.index({ date: 1, 'assigned_staff.clock_in_time': 1 });

// A 1-to-1 must name its service user; background shifts must not. Enforced only when
// the shift is new or either field changes, so legacy migrated 1-to-1s (no service user
// yet) stay valid until an admin edits them.
shiftSchema.pre('validate', function(next) {
  if (!this.isNew && !this.isModified('shift_type') && !this.isModified('service_user_id')) {
    return next();
  }
  if (this.shift_type === 'one_to_one' && !this.service_user_id) {
    this.invalidate('service_user_id', 'A 1-to-1 shift must be linked to a service user');
  } else if (this.shift_type !== 'one_to_one' && this.service_user_id) {
    this.invalidate('service_user_id', 'Only 1-to-1 shifts can be linked to a service user');
  }
  next();
});

// Virtual for shift duration in hours
shiftSchema.virtual('duration_hours').get(function() {
  if (!this.start_time || !this.end_time) return 0;
  
  const [startHours, startMinutes] = this.start_time.split(':').map(Number);
  const [endHours, endMinutes] = this.end_time.split(':').map(Number);
  
  let startTotal = startHours * 60 + startMinutes;
  let endTotal = endHours * 60 + endMinutes;
  
  // Handle overnight shifts
  if (endTotal < startTotal) {
    endTotal += 24 * 60; // Add 24 hours
  }
  
  return (endTotal - startTotal) / 60;
});

shiftSchema.virtual('sleep_in_hours').get(function() {
  return getShiftHourBreakdown(this).sleep_in_hours;
});

/** Paid working hours for caps/payroll: full duration except night-sleep (8h sleep-in removed). */
shiftSchema.virtual('paid_work_hours').get(function() {
  return getShiftHourBreakdown(this).paid_work_hours;
});

// Virtual for shift status
shiftSchema.virtual('status').get(function() {
  if (!this.assigned_staff || this.assigned_staff.length === 0) return 'unassigned';
  if (this.assigned_staff.length < this.required_staff_count) return 'understaffed';
  if (this.assigned_staff.length === this.required_staff_count) return 'fully_staffed';
  return 'overstaffed';
});

// Virtual for shift info (excluding sensitive data)
shiftSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    home_id: this.home_id,
    service_id: this.service_id,
    date: this.date,
    start_time: this.start_time,
    end_time: this.end_time,
    shift_type: this.shift_type,
    service_user_id: this.service_user_id,
    required_staff_count: this.required_staff_count,
    assigned_staff: this.assigned_staff,
    is_urgent: this.is_urgent,
    notes: this.notes,
    is_active: this.is_active,
    duration_hours: this.duration_hours,
    sleep_in_hours: this.sleep_in_hours,
    paid_work_hours: this.paid_work_hours,
    status: this.status
  };
});

// Method to check if staff member is available for this shift
shiftSchema.methods.isStaffAvailable = function(staffId, availabilityData) {
  // Check if staff is already assigned
  const isAssigned = this.assigned_staff.some(assignment => 
    assignment.user_id.toString() === staffId.toString()
  );
  
  if (isAssigned) return false;
  
  // Check availability data if provided
  if (availabilityData) {
    // Since date is now a string, we can use it directly
    const dateStr = this.date;
    const staffAvailability = availabilityData.find(av => 
      av.user_id.toString() === staffId.toString() && 
      av.date === dateStr
    );
    
    if (staffAvailability && !staffAvailability.is_available) {
      return false;
    }
  }
  
  return true;
};

// Method to assign staff member
shiftSchema.methods.assignStaff = function(staffId, note = '', opts = {}) {
  // Check if staff is already assigned
  const existingAssignment = this.assigned_staff.find(assignment =>
    assignment.user_id.toString() === staffId.toString()
  );

  if (existingAssignment) {
    throw new Error('Staff member is already assigned to this shift');
  }

  // Check if shift is fully staffed
  if (this.assigned_staff.length >= this.required_staff_count) {
    throw new Error('Shift is already fully staffed');
  }

  this.assigned_staff.push({
    user_id: staffId,
    status: 'assigned',
    assigned_at: new Date(),
    note,
    rest_exception_status: opts.rest_exception_status || 'none'
  });

  return this;
};

// Method to remove staff member
shiftSchema.methods.removeStaff = function(staffId) {
  const index = this.assigned_staff.findIndex(assignment => 
    assignment.user_id.toString() === staffId.toString()
  );
  
  if (index === -1) {
    throw new Error('Staff member is not assigned to this shift');
  }
  
  this.assigned_staff.splice(index, 1);
  return this;
};

// Ensure virtual fields are serialized
shiftSchema.set('toJSON', { virtuals: true });
shiftSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Shift', shiftSchema);
