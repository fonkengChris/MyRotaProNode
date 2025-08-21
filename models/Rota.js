const mongoose = require('mongoose');

const rotaSchema = new mongoose.Schema({
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
  week_start_date: {
    type: Date,
    required: [true, 'Week start date is required']
  },
  week_end_date: {
    type: Date,
    required: [true, 'Week end date is required']
  },
  status: {
    type: String,
    enum: ['draft', 'published', 'archived'],
    default: 'draft'
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Creator ID is required']
  },
  shifts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift'
  }],
  total_hours: {
    type: Number,
    default: 0
  },
  total_shifts: {
    type: Number,
    default: 0
  },
  notes: {
    type: String,
    maxlength: [1000, 'Notes cannot exceed 1000 characters']
  },
  published_at: {
    type: Date
  },
  archived_at: {
    type: Date
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
rotaSchema.index({ home_id: 1 });
rotaSchema.index({ service_id: 1 });
rotaSchema.index({ week_start_date: 1 });
rotaSchema.index({ status: 1 });
rotaSchema.index({ created_by: 1 });

// Virtual for rota info (excluding sensitive data)
rotaSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    home_id: this.home_id,
    service_id: this.service_id,
    week_start_date: this.week_start_date,
    week_end_date: this.week_end_date,
    status: this.status,
    created_by: this.created_by,
    shifts: this.shifts,
    total_hours: this.total_hours,
    total_shifts: this.total_shifts,
    notes: this.notes,
    published_at: this.published_at,
    archived_at: this.archived_at
  };
});

// Method to publish rota
rotaSchema.methods.publish = function() {
  if (this.status !== 'draft') {
    throw new Error('Only draft rotas can be published');
  }
  
  this.status = 'published';
  this.published_at = new Date();
  return this;
};

// Method to archive rota
rotaSchema.methods.archive = function() {
  if (this.status === 'archived') {
    throw new Error('Rota is already archived');
  }
  
  this.status = 'archived';
  this.archived_at = new Date();
  return this;
};

// Method to revert to draft
rotaSchema.methods.revertToDraft = function() {
  if (this.status === 'archived') {
    throw new Error('Archived rotas cannot be reverted to draft');
  }
  
  this.status = 'draft';
  this.published_at = undefined;
  return this;
};

// Method to calculate total hours
rotaSchema.methods.calculateTotalHours = function() {
  // This would typically be calculated from the shifts
  // For now, we'll use the stored value
  return this.total_hours;
};

// Method to get week number
rotaSchema.virtual('weekNumber').get(function() {
  const start = new Date(this.week_start_date);
  start.setHours(0, 0, 0, 0);
  
  // Thursday in current week decides the year
  start.setDate(start.getDate() + 3 - (start.getDay() + 6) % 7);
  
  // January 4 is always in week 1
  const week1 = new Date(start.getFullYear(), 0, 4);
  
  // Adjust to Thursday in week 1 and count number of weeks from date to week1
  week1.setDate(week1.getDate() + 3 - (week1.getDay() + 6) % 7);
  
  const weekNumber = 1 + 2 * (start.getTime() - week1.getTime()) / (7 * 24 * 3600 * 1000);
  
  return Math.ceil(weekNumber);
});

// Method to check if rota is current week
rotaSchema.methods.isCurrentWeek = function() {
  const now = new Date();
  const start = new Date(this.week_start_date);
  const end = new Date(this.week_end_date);
  
  return now >= start && now <= end;
};

// Method to get rota summary
rotaSchema.methods.getSummary = function() {
  return {
    id: this._id,
    week_number: this.weekNumber,
    status: this.status,
    total_shifts: this.total_shifts,
    total_hours: this.total_hours,
    is_current_week: this.isCurrentWeek()
  };
};

// Ensure virtual fields are serialized
rotaSchema.set('toJSON', { virtuals: true });
rotaSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Rota', rotaSchema);
