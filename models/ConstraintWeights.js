const mongoose = require('mongoose');

const constraintWeightsSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Constraint name is required'],
    unique: true,
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  category: {
    type: String,
    enum: ['hard', 'soft'],
    required: [true, 'Category is required']
  },
  weight: {
    type: Number,
    required: [true, 'Weight is required'],
    min: [0, 'Weight cannot be negative'],
    max: [1000, 'Weight cannot exceed 1000']
  },
  is_active: {
    type: Boolean,
    default: true
  },
  applies_to: {
    type: String,
    enum: ['all', 'specific_home', 'specific_service', 'specific_role'],
    default: 'all'
  },
  target_id: {
    type: mongoose.Schema.Types.ObjectId,
    // Can reference Home, Service, or User depending on applies_to
    required: function() {
      return this.applies_to !== 'all';
    }
  },
  constraint_type: {
    type: String,
    enum: [
      'no_double_booking',
      'respect_time_off',
      'min_staff_required',
      'max_hours_per_week',
      'consecutive_days_limit',
      'preferred_shift_types',
      'skill_requirements',
      'even_distribution',
      'avoid_overtime',
      'preferred_services'
    ],
    required: [true, 'Constraint type is required']
  },
  parameters: {
    // Flexible parameters for different constraint types
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Creator ID is required']
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
constraintWeightsSchema.index({ name: 1 });
constraintWeightsSchema.index({ category: 1 });
constraintWeightsSchema.index({ constraint_type: 1 });
constraintWeightsSchema.index({ is_active: 1 });
constraintWeightsSchema.index({ applies_to: 1 });

// Virtual for constraint info (excluding sensitive data)
constraintWeightsSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    name: this.name,
    description: this.description,
    category: this.category,
    weight: this.weight,
    is_active: this.is_active,
    applies_to: this.applies_to,
    target_id: this.target_id,
    constraint_type: this.constraint_type,
    parameters: this.parameters
  };
});

// Method to check if constraint applies to specific context
constraintWeightsSchema.methods.appliesToContext = function(context) {
  if (this.applies_to === 'all') return true;
  
  switch (this.applies_to) {
    case 'specific_home':
      return context.home_id && context.home_id.toString() === this.target_id.toString();
    case 'specific_service':
      return context.service_id && context.service_id.toString() === this.target_id.toString();
    case 'specific_role':
      return context.user_role && context.user_role === this.target_id.toString();
    default:
      return false;
  }
};

// Method to get constraint penalty score
constraintWeightsSchema.methods.getPenaltyScore = function(violationLevel = 1) {
  if (this.category === 'hard') {
    // Hard constraints should have very high penalties
    return this.weight * 1000 * violationLevel;
  }
  
  // Soft constraints use the weight directly
  return this.weight * violationLevel;
};

// Static method to get active constraints by category
constraintWeightsSchema.statics.getActiveConstraints = function(category = null) {
  const query = { is_active: true };
  if (category) {
    query.category = category;
  }
  return this.find(query).sort({ weight: -1 });
};

// Static method to get constraints for specific context
constraintWeightsSchema.statics.getConstraintsForContext = function(context) {
  return this.find({ is_active: true }).then(constraints => {
    return constraints.filter(constraint => constraint.appliesToContext(context));
  });
};

// Static method to create default constraint weights
constraintWeightsSchema.statics.createDefaultWeights = function(creatorId) {
  const defaultConstraints = [
    {
      name: 'No Double Booking',
      description: 'Staff cannot be assigned to overlapping shifts',
      category: 'hard',
      weight: 1000,
      constraint_type: 'no_double_booking',
      parameters: {},
      created_by: creatorId
    },
    {
      name: 'Respect Time Off',
      description: 'Staff cannot be assigned during approved time off',
      category: 'hard',
      weight: 1000,
      constraint_type: 'respect_time_off',
      parameters: {},
      created_by: creatorId
    },
    {
      name: 'Minimum Staff Required',
      description: 'All shifts must meet minimum staffing requirements',
      category: 'hard',
      weight: 1000,
      constraint_type: 'min_staff_required',
      parameters: {},
      created_by: creatorId
    },
    {
      name: 'Max Hours Per Week',
      description: 'Staff should not exceed maximum weekly hours',
      category: 'soft',
      weight: 50,
      constraint_type: 'max_hours_per_week',
      parameters: { max_hours: 40 },
      created_by: creatorId
    },
    {
      name: 'Consecutive Days Limit',
      description: 'Limit consecutive working days',
      category: 'soft',
      weight: 30,
      constraint_type: 'consecutive_days_limit',
      parameters: { max_consecutive: 6 },
      created_by: creatorId
    },
    {
      name: 'Preferred Shift Types',
      description: 'Respect staff shift type preferences',
      category: 'soft',
      weight: 20,
      constraint_type: 'preferred_shift_types',
      parameters: {},
      created_by: creatorId
    },
    {
      name: 'Skill Requirements',
      description: 'Ensure staff have required skills for services',
      category: 'soft',
      weight: 40,
      constraint_type: 'skill_requirements',
      parameters: {},
      created_by: creatorId
    },
    {
      name: 'Even Distribution',
      description: 'Distribute shifts evenly among staff',
      category: 'soft',
      weight: 25,
      constraint_type: 'even_distribution',
      parameters: {},
      created_by: creatorId
    }
  ];
  
  return this.insertMany(defaultConstraints);
};

// Ensure virtual fields are serialized
constraintWeightsSchema.set('toJSON', { virtuals: true });
constraintWeightsSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ConstraintWeights', constraintWeightsSchema);
