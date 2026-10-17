const mongoose = require('mongoose');

// Company-wide rules the AI solver (services/aiSolver.js) uses to generate rotas and
// timetables, plus the rest/weekly-cap rules the manual-assignment conflict check
// (services/schedulingConflictService.js) enforces. A singleton: read it with
// `SolverSettings.getSettings()`, which seeds DEFAULTS on first access.
//
// DEFAULTS mirror the values that were hardcoded in the solver before these became
// editable, except the full-time weekly limit: 48 paid hours (after break deductions) for
// both the solver and manual assignment, above which only an admin may assign.

const ROLES = ['admin', 'key_worker', 'senior_staff', 'support_worker'];
const EMPLOYMENT_TYPES = ['fulltime', 'parttime', 'bank'];

const DEFAULTS = {
  auto_assignable_roles: ['support_worker'],
  min_rest_hours: 8,
  consecutive_days_enabled: false,
  max_consecutive_days: 6,
  // Weekly hours rules per employment type, all measured on projected paid hours (after each
  // home's unpaid break deduction) for the week being solved.
  //   hard_max                - never auto-assign beyond this
  //   target_min              - below this, staff get below_target_bonus
  //   band_upper              - up to this, staff get in_band_bonus
  //   over_penalty_threshold  - above this, over_penalty is subtracted
  //   priority_soft_max       - staff above this drop a tier when ranking candidates
  //   default_home_bonus      - added when the shift is at the staff member's default home
  hours: {
    fulltime: {
      hard_max: 48, target_min: 38, band_upper: 45, over_penalty_threshold: 48, priority_soft_max: 45,
      below_target_bonus: 25, in_band_bonus: 15, over_penalty: 30, default_home_bonus: 10
    },
    parttime: {
      hard_max: 20, target_min: 0, band_upper: 24, over_penalty_threshold: 24, priority_soft_max: 16,
      below_target_bonus: 0, in_band_bonus: 30, over_penalty: 60, default_home_bonus: 15
    },
    bank: {
      hard_max: 15, target_min: 0, band_upper: 15, over_penalty_threshold: 20, priority_soft_max: 15,
      below_target_bonus: 0, in_band_bonus: 5, over_penalty: 80, default_home_bonus: 5
    }
  },
  // Rules for manual assignment on the rota grid (not used by the solver): going over the
  // full-time weekly cap needs one of approver_roles.
  manual_assign_cap: {
    fulltime_hours: 48,
    approver_roles: ['admin']
  },
  scoring: {
    non_preferred_shift_type_penalty: 30,
    outside_available_hours_penalty: 20,
    default_home_sort_boost: 20
  },
  fairness: {
    weekend_penalty_per_prior: 14,
    weekend_penalty_cap: 55,
    distribution_penalty_per_prior: 2,
    distribution_penalty_cap: 35
  },
  // Share of shift slots each employment type is prioritised for; bank gets the rest.
  type_mix: {
    fulltime_share: 0.7,
    fulltime_max_per_head: 20,
    parttime_share: 0.25,
    parttime_max_per_head: 8
  }
};

const num = (min, max) => ({ type: Number, required: true, min, max });
const hoursField = num(0, 168);
const scoreField = num(0, 1000);

const hoursRuleSchema = new mongoose.Schema({
  hard_max: hoursField,
  target_min: hoursField,
  band_upper: hoursField,
  over_penalty_threshold: hoursField,
  priority_soft_max: hoursField,
  below_target_bonus: scoreField,
  in_band_bonus: scoreField,
  over_penalty: scoreField,
  default_home_bonus: scoreField
}, { _id: false });

const solverSettingsSchema = new mongoose.Schema({
  auto_assignable_roles: {
    type: [{ type: String, enum: ROLES }],
    validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: 'At least one auto-assignable role is required' }
  },
  min_rest_hours: num(0, 24),
  consecutive_days_enabled: { type: Boolean, default: false },
  max_consecutive_days: num(1, 14),
  hours: {
    fulltime: { type: hoursRuleSchema, required: true },
    parttime: { type: hoursRuleSchema, required: true },
    bank: { type: hoursRuleSchema, required: true }
  },
  manual_assign_cap: {
    fulltime_hours: hoursField,
    approver_roles: {
      type: [{ type: String, enum: ROLES }],
      validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: 'At least one approver role is required' }
    }
  },
  scoring: {
    non_preferred_shift_type_penalty: scoreField,
    outside_available_hours_penalty: scoreField,
    default_home_sort_boost: scoreField
  },
  fairness: {
    weekend_penalty_per_prior: scoreField,
    weekend_penalty_cap: scoreField,
    distribution_penalty_per_prior: scoreField,
    distribution_penalty_cap: scoreField
  },
  type_mix: {
    fulltime_share: num(0, 1),
    fulltime_max_per_head: num(0, 100),
    parttime_share: num(0, 1),
    parttime_max_per_head: num(0, 100)
  },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

solverSettingsSchema.pre('validate', function (next) {
  const mix = this.type_mix || {};
  if ((mix.fulltime_share || 0) + (mix.parttime_share || 0) > 1) {
    this.invalidate('type_mix', 'Full-time and part-time shares cannot add up to more than 100%');
  }
  next();
});

// Returns the single settings document, creating it if it doesn't exist yet.
solverSettingsSchema.statics.getSettings = async function () {
  const existing = await this.findOne();
  if (existing) return existing;
  return this.create(JSON.parse(JSON.stringify(DEFAULTS)));
};

// Restores every rule to DEFAULTS.
solverSettingsSchema.statics.resetToDefaults = async function (userId) {
  const settings = await this.getSettings();
  settings.set(JSON.parse(JSON.stringify(DEFAULTS)));
  settings.updated_by = userId;
  await settings.save();
  return settings;
};

// Full-time weekly cap for manual assignment, in the shape the conflict service expects.
solverSettingsSchema.statics.getFulltimeWeeklyHoursPolicy = async function () {
  const settings = await this.getSettings();
  return {
    capHours: settings.manual_assign_cap.fulltime_hours,
    approverRoles: settings.manual_assign_cap.approver_roles
  };
};

solverSettingsSchema.statics.DEFAULTS = DEFAULTS;
solverSettingsSchema.statics.ROLES = ROLES;
solverSettingsSchema.statics.EMPLOYMENT_TYPES = EMPLOYMENT_TYPES;

module.exports = mongoose.model('SolverSettings', solverSettingsSchema);
