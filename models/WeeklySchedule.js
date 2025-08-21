const mongoose = require('mongoose');

const weeklyScheduleSchema = new mongoose.Schema({
  home_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: [true, 'Home ID is required'],
    unique: true // Each home can only have one weekly schedule
  },
  schedule: {
    monday: {
      is_active: {
        type: Boolean,
        default: true
      },
      shifts: [{
        service_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Service',
          required: true
        },
        start_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        end_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        shift_type: {
          type: String,
          enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
          required: true
        },
        required_staff_count: {
          type: Number,
          required: true,
          min: [1, 'Required staff count must be at least 1'],
          max: [50, 'Required staff count cannot exceed 50']
        },
        notes: {
          type: String,
          maxlength: [500, 'Notes cannot exceed 500 characters']
        }
      }]
    },
    tuesday: {
      is_active: {
        type: Boolean,
        default: true
      },
      shifts: [{
        service_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Service',
          required: true
        },
        start_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        end_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        shift_type: {
          type: String,
          enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
          required: true
        },
        required_staff_count: {
          type: Number,
          required: true,
          min: [1, 'Required staff count must be at least 1'],
          max: [50, 'Required staff count cannot exceed 50']
        },
        notes: {
          type: String,
          maxlength: [500, 'Notes cannot exceed 500 characters']
        }
      }]
    },
    wednesday: {
      is_active: {
        type: Boolean,
        default: true
      },
      shifts: [{
        service_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Service',
          required: true
        },
        start_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        end_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        shift_type: {
          type: String,
          enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
          required: true
        },
        required_staff_count: {
          type: Number,
          required: true,
          min: [1, 'Required staff count must be at least 1'],
          max: [50, 'Required staff count cannot exceed 50']
        },
        notes: {
          type: String,
          maxlength: [500, 'Notes cannot exceed 500 characters']
        }
      }]
    },
    thursday: {
      is_active: {
        type: Boolean,
        default: true
      },
      shifts: [{
        service_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Service',
          required: true
        },
        start_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        end_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        shift_type: {
          type: String,
          enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
        },
        required_staff_count: {
          type: Number,
          required: true,
          min: [1, 'Required staff count must be at least 1'],
          max: [50, 'Required staff count cannot exceed 50']
        },
        notes: {
          type: String,
          maxlength: [500, 'Notes cannot exceed 500 characters']
        }
      }]
    },
    friday: {
      is_active: {
        type: Boolean,
        default: true
      },
      shifts: [{
        service_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Service',
          required: true
        },
        start_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        end_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        shift_type: {
          type: String,
          enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
          required: true
        },
        required_staff_count: {
          type: Number,
          required: true,
          min: [1, 'Required staff count must be at least 1'],
          max: [50, 'Required staff count cannot exceed 50']
        },
        notes: {
          type: String,
          maxlength: [500, 'Notes cannot exceed 500 characters']
        }
      }]
    },
    saturday: {
      is_active: {
        type: Boolean,
        default: true
      },
      shifts: [{
        service_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Service',
          required: true
        },
        start_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        end_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        shift_type: {
          type: String,
          enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
          required: true
        },
        required_staff_count: {
          type: Number,
          required: true,
          min: [1, 'Required staff count must be at least 1'],
          max: [50, 'Required staff count cannot exceed 50']
        },
        notes: {
          type: String,
          maxlength: [500, 'Notes cannot exceed 500 characters']
        }
      }]
    },
    sunday: {
      is_active: {
        type: Boolean,
        default: true
      },
      shifts: [{
        service_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Service',
          required: true
        },
        start_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        end_time: {
          type: String,
          required: true,
          match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
        },
        shift_type: {
          type: String,
          enum: ['morning', 'afternoon', 'evening', 'night', 'overtime', 'long_day', 'split'],
          required: true
        },
        required_staff_count: {
          type: Number,
          required: true,
          min: [1, 'Required staff count must be at least 1'],
          max: [50, 'Required staff count cannot exceed 50']
        },
        notes: {
          type: String,
          maxlength: [500, 'Notes cannot exceed 500 characters']
        }
      }]
    }
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
weeklyScheduleSchema.index({ home_id: 1 });
weeklyScheduleSchema.index({ is_active: 1 });

// Virtual for total weekly hours
weeklyScheduleSchema.virtual('totalWeeklyHours').get(function() {
  let total = 0;
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  days.forEach(day => {
    if (this.schedule[day] && this.schedule[day].is_active) {
      this.schedule[day].shifts.forEach(shift => {
        const [startHours, startMinutes] = shift.start_time.split(':').map(Number);
        const [endHours, endMinutes] = shift.end_time.split(':').map(Number);
        
        let startTotal = startHours * 60 + startMinutes;
        let endTotal = endHours * 60 + endMinutes;
        
        // Handle overnight shifts
        if (endTotal < startTotal) {
          endTotal += 24 * 60; // Add 24 hours
        }
        
        total += (endTotal - startTotal) / 60;
      });
    }
  });
  
  return total;
});

// Virtual for total weekly shifts
weeklyScheduleSchema.virtual('totalWeeklyShifts').get(function() {
  let total = 0;
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  days.forEach(day => {
    if (this.schedule[day] && this.schedule[day].is_active) {
      total += this.schedule[day].shifts.length;
    }
  });
  
  return total;
});

// Method to get active days
weeklyScheduleSchema.methods.getActiveDays = function() {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return days.filter(day => this.schedule[day] && this.schedule[day].is_active);
};

// Method to get shifts for a specific day
weeklyScheduleSchema.methods.getShiftsForDay = function(dayName) {
  const day = dayName.toLowerCase();
  if (this.schedule[day] && this.schedule[day].is_active) {
    return this.schedule[day].shifts;
  }
  return [];
};

// Method to add shift to a specific day
weeklyScheduleSchema.methods.addShiftToDay = function(dayName, shiftData) {
  const day = dayName.toLowerCase();
  if (!this.schedule[day]) {
    this.schedule[day] = { is_active: true, shifts: [] };
  }
  this.schedule[day].shifts.push(shiftData);
  return this;
};

// Method to remove shift from a specific day
weeklyScheduleSchema.methods.removeShiftFromDay = function(dayName, shiftIndex) {
  const day = dayName.toLowerCase();
  if (this.schedule[day] && this.schedule[day].shifts[shiftIndex]) {
    this.schedule[day].shifts.splice(shiftIndex, 1);
  }
  return this;
};

// Ensure virtual fields are serialized
weeklyScheduleSchema.set('toJSON', { virtuals: true });
weeklyScheduleSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('WeeklySchedule', weeklyScheduleSchema);
