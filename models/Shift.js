const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema({
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
  shift_type: {
    type: String,
    enum: ['morning', 'day', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
    required: [true, 'Shift type is required']
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
    note: String
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
shiftSchema.index({ service_id: 1 });
shiftSchema.index({ date: 1 });
shiftSchema.index({ 'assigned_staff.user_id': 1 });
shiftSchema.index({ is_active: 1 });

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

// Virtual for shift status
shiftSchema.virtual('status').get(function() {
  if (this.assigned_staff.length === 0) return 'unassigned';
  if (this.assigned_staff.length < this.required_staff_count) return 'understaffed';
  if (this.assigned_staff.length === this.required_staff_count) return 'fully_staffed';
  return 'overstaffed';
});

// Virtual for shift info (excluding sensitive data)
shiftSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    service_id: this.service_id,
    date: this.date,
    start_time: this.start_time,
    end_time: this.end_time,
    shift_type: this.shift_type,
    required_staff_count: this.required_staff_count,
    assigned_staff: this.assigned_staff,
    is_urgent: this.is_urgent,
    notes: this.notes,
    is_active: this.is_active,
    duration_hours: this.duration_hours,
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
shiftSchema.methods.assignStaff = function(staffId, note = '') {
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
    note
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
