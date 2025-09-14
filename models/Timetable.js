const mongoose = require('mongoose');

const timetableSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Timetable name is required'],
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  description: {
    type: String,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  home_ids: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: true
  }],
  service_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: [true, 'Service ID is required']
  },
  start_date: {
    type: Date,
    required: [true, 'Start date is required']
  },
  end_date: {
    type: Date,
    required: [true, 'End date is required']
  },
  total_weeks: {
    type: Number,
    required: [true, 'Total weeks is required'],
    min: [1, 'Must be at least 1 week'],
    max: [52, 'Cannot exceed 52 weeks']
  },
  status: {
    type: String,
    enum: ['draft', 'generating', 'generated', 'published', 'archived'],
    default: 'draft'
  },
  generated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Generator ID is required']
  },
  // Immutable shift data - snapshots of the rota at generation time
  weekly_rotas: [{
    week_start_date: {
      type: Date,
      required: true
    },
    week_end_date: {
      type: Date,
      required: true
    },
    week_number: {
      type: Number,
      required: true
    },
    shifts: [{
      shift_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shift',
        required: true
      },
      home_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Home',
        required: true
      },
      service_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Service',
        required: true
      },
      date: {
        type: String,
        required: true
      },
      start_time: {
        type: String,
        required: true
      },
      end_time: {
        type: String,
        required: true
      },
      shift_type: {
        type: String,
        required: true
      },
      required_staff_count: {
        type: Number,
        required: true
      },
      assigned_staff: [{
        user_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true
        },
        name: {
          type: String,
          required: true
        },
        role: {
          type: String,
          required: true
        },
        type: {
          type: String,
          required: true
        },
        status: {
          type: String,
          default: 'assigned'
        },
        assigned_at: {
          type: Date,
          default: Date.now
        }
      }],
      notes: String,
      duration_hours: {
        type: Number,
        required: true
      }
    }],
    total_shifts: {
      type: Number,
      required: true
    },
    total_hours: {
      type: Number,
      required: true
    },
    total_assignments: {
      type: Number,
      required: true
    },
    employment_distribution: {
      fulltime: {
        total_hours: Number,
        staff_count: Number,
        average_hours: Number
      },
      parttime: {
        total_hours: Number,
        staff_count: Number,
        average_hours: Number
      },
      bank: {
        total_hours: Number,
        staff_count: Number,
        average_hours: Number
      }
    }
  }],
  // Summary statistics
  total_shifts: {
    type: Number,
    required: true
  },
  total_hours: {
    type: Number,
    required: true
  },
  total_assignments: {
    type: Number,
    required: true
  },
  average_weekly_hours: {
    type: Number,
    required: true
  },
  // Generation metadata
  generation_started_at: {
    type: Date
  },
  generation_completed_at: {
    type: Date
  },
  generation_duration_ms: {
    type: Number
  },
  conflicts_detected: {
    type: Number,
    default: 0
  },
  generation_errors: [{
    week: Number,
    error: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  // Access control
  is_public: {
    type: Boolean,
    default: false
  },
  accessible_by_roles: [{
    type: String,
    enum: ['admin', 'home_manager', 'senior_staff', 'support_worker']
  }],
  accessible_by_users: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
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
timetableSchema.index({ home_ids: 1 });
timetableSchema.index({ service_id: 1 });
timetableSchema.index({ start_date: 1, end_date: 1 });
timetableSchema.index({ status: 1 });
timetableSchema.index({ generated_by: 1 });
timetableSchema.index({ is_public: 1 });

// Virtual for timetable duration in weeks
timetableSchema.virtual('duration_weeks').get(function() {
  if (!this.start_date || !this.end_date) return 0;
  
  const start = new Date(this.start_date);
  const end = new Date(this.end_date);
  
  const timeDiff = end.getTime() - start.getTime();
  const weeksDiff = Math.ceil(timeDiff / (7 * 24 * 60 * 60 * 1000));
  
  return weeksDiff;
});

// Virtual for timetable info (excluding sensitive data)
timetableSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    name: this.name,
    description: this.description,
    home_ids: this.home_ids,
    service_id: this.service_id,
    start_date: this.start_date,
    end_date: this.end_date,
    total_weeks: this.total_weeks,
    status: this.status,
    total_shifts: this.total_shifts,
    total_hours: this.total_hours,
    total_assignments: this.total_assignments,
    average_weekly_hours: this.average_weekly_hours,
    is_public: this.is_public,
    created_at: this.created_at,
    updated_at: this.updated_at
  };
});

// Method to publish timetable
timetableSchema.methods.publish = function() {
  if (!['draft', 'generated'].includes(this.status)) {
    throw new Error('Only draft or generated timetables can be published');
  }
  
  if (this.conflicts_detected > 0) {
    throw new Error('Cannot publish timetable with conflicts detected');
  }
  
  this.status = 'published';
  return this;
};

// Method to archive timetable
timetableSchema.methods.archive = function() {
  if (this.status === 'archived') {
    throw new Error('Timetable is already archived');
  }
  
  this.status = 'archived';
  return this;
};

// Method to check if user can access timetable
timetableSchema.methods.canUserAccess = function(user) {
  try {
    // Validate inputs
    if (!user || !user._id || !user.role) {
      console.error('Invalid user object passed to canUserAccess:', user);
      return false;
    }
    
    // Public timetables can be accessed by anyone
    if (this.is_public) {
      return true;
    }
    
    // Generator can always access
    if (this.generated_by && this.generated_by.toString() === user._id.toString()) {
      return true;
    }
    
    // Check if user is in accessible users list
    if (this.accessible_by_users && Array.isArray(this.accessible_by_users)) {
      if (this.accessible_by_users.some(userId => userId.toString() === user._id.toString())) {
        return true;
      }
    }
    
    // Check if user role is in accessible roles
    if (this.accessible_by_roles && Array.isArray(this.accessible_by_roles)) {
      if (this.accessible_by_roles.includes(user.role)) {
        return true;
      }
    }
    
    // Admins can access all timetables
    if (user.role === 'admin') {
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error in canUserAccess method:', error);
    console.error('User object:', user);
    console.error('Timetable object:', {
      id: this._id,
      is_public: this.is_public,
      generated_by: this.generated_by,
      accessible_by_users: this.accessible_by_users,
      accessible_by_roles: this.accessible_by_roles
    });
    return false;
  }
};

// Method to get timetable summary
timetableSchema.methods.getSummary = function() {
  return {
    id: this._id,
    name: this.name,
    description: this.description,
    duration_weeks: this.duration_weeks,
    status: this.status,
    total_shifts: this.total_shifts,
    total_hours: this.total_hours,
    total_assignments: this.total_assignments,
    average_weekly_hours: this.average_weekly_hours,
    conflicts_detected: this.conflicts_detected,
    is_public: this.is_public,
    created_at: this.created_at
  };
};

// Method to get weekly breakdown
timetableSchema.methods.getWeeklyBreakdown = function() {
  return this.weekly_rotas.map(week => ({
    week_number: week.week_number,
    week_start_date: week.week_start_date,
    week_end_date: week.week_end_date,
    total_shifts: week.total_shifts,
    total_hours: week.total_hours,
    total_assignments: week.total_assignments,
    employment_distribution: week.employment_distribution
  }));
};

// Ensure virtual fields are serialized
timetableSchema.set('toJSON', { virtuals: true });
timetableSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Timetable', timetableSchema);
