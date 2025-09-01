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
    enum: ['all', 'specific_home', 'specific_service', 'specific_role', 'specific_employment_type'],
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
      'min_hours_per_week',
      'max_hours_per_week',
      'consecutive_days_limit',
      'preferred_shift_types',
      'skill_requirements',
      'even_distribution',
      'avoid_overtime',
      'preferred_services',
      'employment_type_compliance',
      'shift_priority'
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
      // Check if user has access to this home through their homes array
      return context.user_homes && context.user_homes.some(home => 
        home.home_id.toString() === this.target_id.toString()
      );
    case 'specific_service':
      return context.service_id && context.service_id.toString() === this.target_id.toString();
    case 'specific_role':
      return context.user_role && context.user_role === this.target_id.toString();
    case 'specific_employment_type':
      return context.user_type && context.user_type === this.target_id.toString();
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

// Method to calculate hours-based constraint penalties
constraintWeightsSchema.methods.calculateHoursPenalty = function(userType, actualHours, targetHours = null) {
  if (this.constraint_type === 'min_hours_per_week') {
    const minHours = this.parameters[userType] || 0;
    if (actualHours < minHours) {
      const deficit = minHours - actualHours;
      // Higher penalty for larger deficits
      return this.getPenaltyScore() * (1 + deficit / 10);
    }
    return 0;
  }
  
  if (this.constraint_type === 'max_hours_per_week') {
    // Get max hours based on employment type
    const maxHours = this.parameters[userType] || 40;
    const overtimeThreshold = this.parameters.overtime_threshold || 40;
    const overtimeMultiplier = this.parameters.overtime_penalty_multiplier || 1.5;
    
    if (actualHours > maxHours) {
      const excess = actualHours - maxHours;
      let penalty = this.getPenaltyScore();
      
      // Apply overtime penalty multiplier if over threshold
      if (actualHours > overtimeThreshold) {
        penalty *= overtimeMultiplier;
      }
      
      return penalty * (1 + excess / 10);
    }
    return 0;
  }
  
  if (this.constraint_type === 'employment_type_compliance') {
    const preference = this.parameters[`${userType}_preference`] || 0.5;
    const expectedHours = targetHours || 40;
    const actualRatio = actualHours / expectedHours;
    
    // Penalty if actual hours don't match employment type expectations
    if (Math.abs(actualRatio - preference) > 0.2) {
      return this.getPenaltyScore() * Math.abs(actualRatio - preference);
    }
    return 0;
  }
  
  if (this.constraint_type === 'shift_priority') {
    // This constraint affects shift assignment priority, not direct penalties
    // It's used during scheduling to prioritize certain employment types
    return 0; // No direct penalty calculation
  }
  
  return 0;
};

// Method to calculate shift assignment priority score
constraintWeightsSchema.methods.calculateShiftPriority = function(userType, availableUsers = []) {
  if (this.constraint_type !== 'shift_priority') {
    return 0;
  }
  
  const priorityOrder = this.parameters.priority_order || ['fulltime', 'parttime', 'bank'];
  const parttimeOverBankBoost = this.parameters.parttime_over_bank_boost || 1.5;
  const fulltimeOverParttimeBoost = this.parameters.fulltime_over_parttime_boost || 1.2;
  
  // Get user's priority rank (lower number = higher priority)
  const userPriorityRank = priorityOrder.indexOf(userType);
  if (userPriorityRank === -1) return 0;
  
  // Calculate base priority score (inverse of rank)
  let priorityScore = 1 / (userPriorityRank + 1);
  
  // Apply employment type specific boosts
  if (userType === 'parttime') {
    // Check if there are bank staff available for this shift
    const bankStaffAvailable = availableUsers.some(user => user.type === 'bank');
    if (bankStaffAvailable) {
      priorityScore *= parttimeOverBankBoost;
    }
  } else if (userType === 'fulltime') {
    // Check if there are part-time staff available
    const parttimeStaffAvailable = availableUsers.some(user => user.type === 'parttime');
    if (parttimeStaffAvailable) {
      priorityScore *= fulltimeOverParttimeBoost;
    }
  }
  
  return priorityScore;
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

// Static method to validate user hours against employment type constraints
constraintWeightsSchema.statics.validateUserHours = async function(userType, actualHours, targetHours = null) {
  const hourConstraints = await this.find({
    is_active: true,
    constraint_type: { $in: ['min_hours_per_week', 'max_hours_per_week', 'employment_type_compliance'] }
  });

  const violations = [];
  let totalPenalty = 0;

  for (const constraint of hourConstraints) {
    const penalty = constraint.calculateHoursPenalty(userType, actualHours, targetHours);
    if (penalty > 0) {
      violations.push({
        constraint: constraint.name,
        constraint_type: constraint.constraint_type,
        category: constraint.category,
        penalty: penalty,
        message: this.getViolationMessage(constraint, userType, actualHours, targetHours)
      });
      totalPenalty += penalty;
    }
  }

  return {
    isValid: violations.length === 0,
    violations: violations,
    totalPenalty: totalPenalty,
    userType: userType,
    actualHours: actualHours,
    targetHours: targetHours
  };
};

// Helper method to generate violation messages
constraintWeightsSchema.statics.getViolationMessage = function(constraint, userType, actualHours, targetHours) {
  switch (constraint.constraint_type) {
    case 'min_hours_per_week':
      const minHours = constraint.parameters[userType] || 0;
      if (actualHours < minHours) {
        return `${userType} staff must work at least ${minHours} hours per week (currently: ${actualHours})`;
      }
      break;
    
    case 'max_hours_per_week':
      const maxHours = constraint.parameters[userType] || 40; // Changed to use userType specific max hours
      if (actualHours > maxHours) {
        return `${userType} staff cannot exceed ${maxHours} hours per week (currently: ${actualHours})`;
      }
      break;
    
    case 'employment_type_compliance':
      const preference = constraint.parameters[`${userType}_preference`] || 0.5;
      const expectedHours = targetHours || 40;
      const actualRatio = actualHours / expectedHours;
      if (Math.abs(actualRatio - preference) > 0.2) {
        return `${userType} staff should work closer to ${Math.round(preference * expectedHours)} hours per week`;
      }
      break;
  }
  return 'Constraint violation detected';
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
      name: 'Minimum Hours Per Week',
      description: 'Staff must meet minimum weekly hours based on employment type',
      category: 'hard',
      weight: 800,
      constraint_type: 'min_hours_per_week',
      parameters: {
        fulltime: 38,
        parttime: 0,
        bank: 0
      },
      created_by: creatorId
    },
    {
      name: 'Maximum Hours Per Week',
      description: 'Staff should not exceed maximum weekly hours based on employment type',
      category: 'soft',
      weight: 100,
      constraint_type: 'max_hours_per_week',
      parameters: { 
        fulltime: 80,
        parttime: 20,
        bank: 20,
        overtime_threshold: 40,
        overtime_penalty_multiplier: 1.5
      },
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
    },
    {
      name: 'Employment Type Compliance',
      description: 'Ensure scheduling respects employment type constraints',
      category: 'soft',
      weight: 60,
      constraint_type: 'employment_type_compliance',
      parameters: {
        fulltime_preference: 0.8,
        parttime_preference: 0.6,
        bank_preference: 0.4
      },
      created_by: creatorId
    },
    {
      name: 'Shift Priority',
      description: 'Prioritize scheduling for certain employment types',
      category: 'soft',
      weight: 50,
      constraint_type: 'shift_priority',
      parameters: {
        priority_order: ['fulltime', 'parttime', 'bank'],
        parttime_over_bank_boost: 1.5,
        fulltime_over_parttime_boost: 1.2
      },
      created_by: creatorId
    }
  ];
  
  return this.insertMany(defaultConstraints);
};

// Ensure virtual fields are serialized
constraintWeightsSchema.set('toJSON', { virtuals: true });
constraintWeightsSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ConstraintWeights', constraintWeightsSchema);
