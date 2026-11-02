const mongoose = require('mongoose');

// What key workers may reach, set by admins. A singleton: read it with
// `KeyWorkerAccessSettings.getSettings()`, which seeds DEFAULTS on first access.
// `User.key_worker_access` holds per-person overrides; `resolveFor` merges the two.
//
// staff/weekly_schedules/rota: hidden (no page, no writes), view (read only) or full.
// shift_selection/shift_swaps/my_hours: personal pages, hidden or visible.
// service_users: read-only view of `all` service users, or just their `own` caseload. Home
// reach still comes from the caseload (getUserHomeIds), and home_scope limits this list too.
// home_scope: `all` homes, or `own` (getUserHomeIds: their homes + their service users' homes).

const LEVELS = ['hidden', 'view', 'full'];
const VISIBILITY = ['hidden', 'visible'];
const HOME_SCOPES = ['all', 'own'];
const SERVICE_USER_VIEWS = ['all', 'own'];

const FIELD_VALUES = {
  staff: LEVELS,
  weekly_schedules: LEVELS,
  rota: LEVELS,
  shift_selection: VISIBILITY,
  shift_swaps: VISIBILITY,
  my_hours: VISIBILITY,
  service_users: SERVICE_USER_VIEWS,
  home_scope: HOME_SCOPES
};

const DEFAULTS = {
  staff: 'full',
  weekly_schedules: 'full',
  rota: 'full',
  shift_selection: 'hidden',
  shift_swaps: 'hidden',
  my_hours: 'hidden',
  service_users: 'all',
  home_scope: 'all'
};

const schemaFields = {};
for (const [field, values] of Object.entries(FIELD_VALUES)) {
  schemaFields[field] = { type: String, enum: values, default: DEFAULTS[field] };
}

const keyWorkerAccessSettingsSchema = new mongoose.Schema({
  ...schemaFields,
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

keyWorkerAccessSettingsSchema.statics.getSettings = async function () {
  const existing = await this.findOne();
  if (existing) return existing;
  return this.create({ ...DEFAULTS });
};

// Restores every setting to DEFAULTS. Per-person overrides are left alone.
keyWorkerAccessSettingsSchema.statics.resetToDefaults = async function (userId) {
  const settings = await this.getSettings();
  settings.set({ ...DEFAULTS });
  settings.updated_by = userId;
  await settings.save();
  return settings;
};

// The effective access for a key worker: the org settings, with their own overrides on top.
keyWorkerAccessSettingsSchema.statics.resolveFor = async function (overrides) {
  const settings = await this.getSettings();
  const access = {};
  for (const field of Object.keys(FIELD_VALUES)) {
    access[field] = (overrides && overrides[field]) || settings[field];
  }
  return access;
};

keyWorkerAccessSettingsSchema.statics.DEFAULTS = DEFAULTS;
keyWorkerAccessSettingsSchema.statics.FIELD_VALUES = FIELD_VALUES;

module.exports = mongoose.model('KeyWorkerAccessSettings', keyWorkerAccessSettingsSchema);
