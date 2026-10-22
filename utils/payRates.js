// Default hourly rates (GBP) by role. Each staff member carries their own
// `hourly_rate` (see models/User.js); these are only the starting value given to a
// new user, and the fallback for any record that predates the field.
const DEFAULT_ROLE_RATES_GBP = Object.freeze({
  support_worker: 12.71,
  senior_staff: 14.0,
  key_worker: 15.0,
  admin: 14.0,
});
const FALLBACK_HOURLY_RATE_GBP = 12.71;
// Upper bound on a staff member's hourly rate, so a typo cannot inflate gross pay.
const MAX_HOURLY_RATE_GBP = 100;

/** Default hourly rate for a role, with a safe fallback for unknown roles. */
function defaultRateForRole(role) {
  const rate = DEFAULT_ROLE_RATES_GBP[role];
  return Number.isFinite(rate) ? rate : FALLBACK_HOURLY_RATE_GBP;
}

/** A staff member's own hourly rate, or their role default if none is stored. */
function hourlyRateFor(user) {
  const rate = user && user.hourly_rate;
  return Number.isFinite(rate) ? rate : defaultRateForRole(user && user.role);
}

module.exports = {
  DEFAULT_ROLE_RATES_GBP,
  FALLBACK_HOURLY_RATE_GBP,
  MAX_HOURLY_RATE_GBP,
  defaultRateForRole,
  hourlyRateFor,
};
