const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true,
    match: [/^[\+]?[1-9][\d]{0,15}$/, 'Please enter a valid phone number']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters long'],
    select: false // Don't include password in queries by default
  },
  role: {
    type: String,
    enum: ['admin', 'home_manager', 'senior_staff', 'support_worker'],
    default: 'support_worker',
    required: true
  },
  home_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: false // Allow users to be created without homes initially
  },
  is_active: {
    type: Boolean,
    default: true
  },
  skills: [{
    type: String,
    enum: ['medication', 'personal_care', 'domestic_support', 'social_support', 'specialist_care']
  }],
  preferred_shift_types: [{
    type: String,
    enum: ['morning', 'afternoon', 'night', 'long_day']
  }],
  max_hours_per_week: {
    type: Number,
    default: 40,
    min: [0, 'Hours cannot be negative'],
    max: [168, 'Hours cannot exceed 168 per week']
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
userSchema.index({ email: 1 });
userSchema.index({ home_id: 1 });
userSchema.index({ role: 1 });
userSchema.index({ is_active: 1 });

// Pre-save middleware to hash password
userSchema.pre('save', async function(next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return next();
  
  try {
    // Hash password with cost of 12
    const hashedPassword = await bcrypt.hash(this.password, 12);
    this.password = hashedPassword;
    next();
  } catch (error) {
    next(error);
  }
});

// Instance method to check password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Instance method to get user permissions
userSchema.methods.getPermissions = function() {
  const permissions = {
    can_manage_users: ['admin', 'home_manager'].includes(this.role),
    can_manage_rotas: ['admin', 'home_manager', 'senior_staff'].includes(this.role),
    can_approve_requests: ['admin', 'home_manager', 'senior_staff'].includes(this.role),
    can_view_all_homes: this.role === 'admin',
    can_manage_homes: this.role === 'admin',
    can_use_ai_solver: ['admin', 'home_manager'].includes(this.role),
    can_allocate_homes: ['admin', 'home_manager'].includes(this.role)
  };
  
  return permissions;
};

// Static method to find users by role and home
userSchema.statics.findByRoleAndHome = function(role, homeId) {
  if (role === 'admin') {
    return this.find({ role });
  }
  return this.find({ role, home_id: homeId });
};

// Virtual for full user info (excluding sensitive data)
userSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    role: this.role,
    home_id: this.home_id,
    is_active: this.is_active,
    skills: this.skills,
    preferred_shift_types: this.preferred_shift_types,
    max_hours_per_week: this.max_hours_per_week
  };
});

// Ensure virtual fields are serialized
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('User', userSchema);
