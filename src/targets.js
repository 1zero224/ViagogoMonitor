const { buildEventIdFromUrl } = require('./utils');

function normalizeDirectTarget(url) {
  return {
    linkId: null,
    url,
    eventId: buildEventIdFromUrl(url),
    name: null,
    artist: null,
    country: null,
    location: null,
    date: null,
    imageUrl: null,
    previousprices: {},
    last_checked: null,
    sourceMode: 'direct',
  };
}

async function loadDatabaseTargets(supabase, config) {
  let query = supabase
    .from('vgg_links')
    .select('id, url, name, artist, country, location, date, imageUrl, previousprices, last_checked')
    .not('url', 'is', null);

  if (config.artistFilter) {
    query = query.ilike('artist', `%${config.artistFilter}%`);
  }

  if (config.countryFilter) {
    query = query.ilike('country', `%${config.countryFilter}%`);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load vgg_links targets: ${error.message}`);
  }

  return (data || []).map((row) => ({
    linkId: row.id,
    url: row.url,
    eventId: buildEventIdFromUrl(row.url),
    name: row.name || null,
    artist: row.artist || null,
    country: row.country || null,
    location: row.location || null,
    date: row.date || null,
    imageUrl: row.imageUrl || null,
    previousprices: row.previousprices || {},
    last_checked: row.last_checked || null,
    sourceMode: 'database',
  }));
}

async function loadTargets({ supabase, config }) {
  if (config.eventUrls.length > 0) {
    return [...new Set(config.eventUrls)].map(normalizeDirectTarget);
  }

  return loadDatabaseTargets(supabase, config);
}

module.exports = {
  loadTargets,
};
