const Home = require('../models/Home');
const Service = require('../models/Service');

/**
 * Attach a home to the services its sibling homes use.
 *
 * Services are linked to homes via Service.home_ids, and the weekly schedule editor
 * only offers services that list the home. A home with no links therefore can't have
 * schedules built for it. We link the home to every active service already used by
 * another home of the same service_type (e.g. a new outreach home joins "Outreach").
 *
 * Idempotent ($addToSet). Returns the names of the services the home was added to.
 */
async function linkHomeToPeerServices(home) {
  const peerHomeIds = await Home.find(
    { _id: { $ne: home._id }, service_type: home.service_type },
    '_id'
  ).distinct('_id');
  if (peerHomeIds.length === 0) return [];

  const services = await Service.find(
    { is_active: true, home_ids: { $in: peerHomeIds, $ne: home._id } },
    '_id name'
  );
  if (services.length === 0) return [];

  await Service.updateMany(
    { _id: { $in: services.map(s => s._id) } },
    { $addToSet: { home_ids: home._id } }
  );
  return services.map(s => s.name);
}

module.exports = { linkHomeToPeerServices };
