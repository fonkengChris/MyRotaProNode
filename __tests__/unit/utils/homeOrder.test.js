const { sortHomes } = require('../../../utils/homeOrder');

describe('sortHomes', () => {
  test('orders by service (supported living, outreach, day centre), then name', () => {
    const homes = [
      { name: 'Sunrise Day Centre', service_type: 'day_centre' },
      { name: 'Elm Outreach', service_type: 'community_outreach' },
      { name: 'Maple House', service_type: 'supported_living' },
      { name: 'Ash Outreach', service_type: 'community_outreach' },
      { name: 'Cedar House' },
    ];
    expect(sortHomes(homes).map((h) => h.name)).toEqual([
      'Cedar House', 'Maple House', 'Ash Outreach', 'Elm Outreach', 'Sunrise Day Centre',
    ]);
  });
});
