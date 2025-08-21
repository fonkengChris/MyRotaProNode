const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Service name is required'],
    trim: true,
    maxlength: [100, 'Service name cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Service description is required'],
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  home_ids: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: [true, 'At least one home is required']
  }],
  category: {
    type: String,
    enum: ['personal_care', 'medical', 'domestic', 'social', 'specialist'],
    required: [true, 'Service category is required']
  },
  required_skills: [{
    type: String,
    enum: ['medication', 'personal_care', 'domestic_support', 'social_support', 'specialist_care'],
    required: [true, 'At least one skill is required']
  }],
  min_staff_count: {
    type: Number,
    required: [true, 'Minimum staff count is required'],
    min: [1, 'Minimum staff count must be at least 1'],
    max: [20, 'Minimum staff count cannot exceed 20']
  },
  max_staff_count: {
    type: Number,
    required: [true, 'Maximum staff count is required'],
    min: [1, 'Maximum staff count must be at least 1'],
    max: [50, 'Maximum staff count cannot exceed 50']
  },
  duration_hours: {
    type: Number,
    required: [true, 'Duration is required'],
    min: [0.5, 'Duration must be at least 0.5 hours'],
    max: [24, 'Duration cannot exceed 24 hours']
  },
  is_24_hour: {
    type: Boolean,
    default: false
  },
  priority_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
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
serviceSchema.index({ home_ids: 1 });
serviceSchema.index({ category: 1 });
serviceSchema.index({ is_active: 1 });
serviceSchema.index({ required_skills: 1 });

// Virtual for service info (excluding sensitive data)
serviceSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    name: this.name,
    description: this.description,
    home_ids: this.home_ids,
    category: this.category,
    required_skills: this.required_skills,
    min_staff_count: this.min_staff_count,
    max_staff_count: this.max_staff_count,
    duration_hours: this.duration_hours,
    is_24_hour: this.is_24_hour,
    priority_level: this.priority_level,
    is_active: this.is_active
  };
});

// Method to check if staff member has required skills
serviceSchema.methods.staffHasRequiredSkills = function(staffSkills) {
  if (!staffSkills || staffSkills.length === 0) return false;
  
  return this.required_skills.every(requiredSkill => 
    staffSkills.includes(requiredSkill)
  );
};

// Method to get optimal staff count
serviceSchema.methods.getOptimalStaffCount = function() {
  return Math.ceil((this.min_staff_count + this.max_staff_count) / 2);
};

// Ensure virtual fields are serialized
serviceSchema.set('toJSON', { virtuals: true });
serviceSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Service', serviceSchema);
