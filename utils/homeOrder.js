// Display order for homes everywhere they are listed: by service (supported living, then
// community outreach, then day centre), then by name. Homes without a service_type count as
// supported living, matching the Home model default.
const SERVICE_ORDER = ['supported_living', 'community_outreach', 'day_centre'];

const serviceRank = (home) => {
  const rank = SERVICE_ORDER.indexOf(home.service_type || 'supported_living');
  return rank === -1 ? SERVICE_ORDER.length : rank;
};

function compareHomes(a, b) {
  return serviceRank(a) - serviceRank(b) || String(a.name || '').localeCompare(String(b.name || ''));
}

const sortHomes = (homes) => [...homes].sort(compareHomes);

module.exports = { compareHomes, sortHomes };
