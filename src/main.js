// src/main.js
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Maps input time ranges to Workable API parameters
const dateMap = {
  '24h': 'past_day',
  '7d': 'past_week',
  '30d': 'past_month',
};

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  startUrls = [],
  keyword = input.query || '',
  location = '',
  posted_date = input.timeRange || 'anytime',
  results_wanted = input.maxJobs || 50,
  maxPagesPerList = 25,
  maxConcurrency = 10,
  proxyConfiguration = null,
} = input;

const targetResults = Math.max(Math.floor(Number(results_wanted)) || 0, 1);
const maxPagesLimit = Math.max(Math.floor(Number(maxPagesPerList)) || 0, 1);
const concurrency = Math.max(Math.floor(Number(maxConcurrency)) || 0, 1);

// ---------- Utilities ----------
function buildCreatedAtPasses(selectedRange) {
  const mapped = dateMap[selectedRange];
  return mapped ? [mapped] : [null];
}

function isJobsHost(u) {
  try { return new URL(u).hostname === 'jobs.workable.com'; } catch { return false; }
}

function isApiListUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname === 'jobs.workable.com' && url.pathname.startsWith('/api/v1/jobs');
  } catch { return false; }
}

function isDetailUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname === 'jobs.workable.com' && url.pathname.startsWith('/view/');
  } catch { return false; }
}

function toApiListUrlFromSearch(u, limit, createdAt = null) {
  const source = new URL(u);
  const params = new URLSearchParams(source.search);
  const api = new URL('https://jobs.workable.com/api/v1/jobs');
  for (const [k, v] of params.entries()) api.searchParams.set(k, v);
  if (createdAt) api.searchParams.set('created_at', createdAt);
  api.searchParams.set('limit', String(limit));
  return api.toString();
}

function normalizeListUrl(userUrl, limit, createdAt = null) {
  if (!userUrl) return null;
  if (isApiListUrl(userUrl)) {
    const u = new URL(userUrl);
    if (!u.searchParams.get('limit')) u.searchParams.set('limit', String(limit));
    if (createdAt !== null) u.searchParams.set('created_at', createdAt);
    u.searchParams.delete('page');
    u.searchParams.delete('pageToken');
    return u.toString();
  }
  if (isDetailUrl(userUrl)) return null;
  if (isJobsHost(userUrl)) return toApiListUrlFromSearch(userUrl, limit, createdAt);
  return null;
}

// ---------- Date passes ----------
const createdAtPasses = buildCreatedAtPasses(posted_date);

// ---------- State ----------
const state = {
  collectedCount: 0,
  queuedCount: 0,
  seen: new Set(),
};

// Handle proxy configuration
const proxyConfig = proxyConfiguration
  ? await Actor.createProxyConfiguration(proxyConfiguration)
  : await Actor.createProxyConfiguration();

// ---------- Detail extractors ----------
function extractJobTypes($) {
  let job_types = null;

  try {
    const ldNodes = $('script[type="application/ld+json"]');
    for (let i = 0; i < ldNodes.length; i++) {
      const jsonText = $(ldNodes[i]).contents().text().trim();
      if (!jsonText) continue;
      let data;
      try { data = JSON.parse(jsonText); } catch { continue; }
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        if (!node) continue;
        const t = node['@type'];
        const isJob = Array.isArray(t) ? t.includes('JobPosting') : t === 'JobPosting';
        if (!isJob) continue;
        const et = node.employmentType;
        if (et) {
          job_types = Array.isArray(et)
            ? et.map(x => String(x).trim()).filter(Boolean)
            : [String(et).trim()].filter(Boolean);
          break;
        }
      }
      if (job_types) break;
    }

    if (!job_types) {
      const candidates = [];
      const re = /full[-\s]?time|part[-\s]?time|contract|temporary|intern(ship)?|freelance|remote/i;
      $('[data-ui="job-meta"], [data-ui="job-tags"], .JobDetails__tags, .job-stats, .job-badges')
        .find('li,span,a,div')
        .each((_, el) => {
          const t = $(el).text().trim();
          if (re.test(t)) candidates.push(t);
        });
      const uniq = [...new Set(candidates)];
      job_types = uniq.length ? uniq : null;
    }
  } catch (e) {
    log.debug(`job_types extraction failed: ${e.message}`);
  }

  return job_types;
}

function extractDetailFields($, url, seed) {
  const titleFallback =
    $('[data-ui="job-title"]').first().text().trim()
    || $('h1').first().text().trim()
    || null;

  const companyFallback =
    $('[data-ui="company-name"]').first().text().trim()
    || $('[itemprop="hiringOrganization"]').text().trim()
    || $('[rel="author"]').first().text().trim()
    || null;

  const locationFallback =
    $('[data-ui="job-location"]').first().text().trim()
    || $('[itemprop="jobLocation"]').text().trim()
    || $('.job-stats, .JobDetails__meta').find('li:contains("Location")').next().text().trim()
    || null;

  const safeTitle = seed?.title ?? titleFallback;
  const safeCompany = seed?.company ?? companyFallback;
  const safeLocationSeed = seed?.location ?? locationFallback;
  const safeDateSeed = seed?.date_posted ?? null;

  let description_html = null;
  let description_text = null;
  let date_posted_extracted = null;
  let location_extracted = safeLocationSeed || null;

  // JSON-LD JobPosting
  try {
    const ldNodes = $('script[type="application/ld+json"]');
    for (let i = 0; i < ldNodes.length; i++) {
      const raw = $(ldNodes[i]).contents().text().trim();
      if (!raw) continue;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      const items = Array.isArray(data) ? data : [data];

      for (const node of items) {
        if (!node) continue;
        const t = node['@type'];
        const isJob = Array.isArray(t) ? t.includes('JobPosting') : t === 'JobPosting';
        if (!isJob) continue;

        if (!description_html && node.description) {
          description_html = String(node.description).trim() || null;
        }
        if (!date_posted_extracted && node.datePosted) {
          date_posted_extracted = String(node.datePosted).trim();
        }
        if (!location_extracted) {
          const toStr = (x) => (x == null ? '' : String(x).trim());
          const joinParts = (parts) => parts.filter(Boolean).join(', ') || null;
          const addrFromNode = (n) => {
            if (!n) return null;
            if (typeof n === 'string') return n.trim();
            const addr = n.address || n;
            if (typeof addr === 'string') return addr.trim();
            return joinParts([
              toStr(addr.addressLocality),
              toStr(addr.addressRegion),
              toStr(addr.addressCountry),
            ]);
          };

          const jl = node.jobLocation;
          if (Array.isArray(jl)) {
            for (const j of jl) {
              const s = addrFromNode(j);
              if (s) { location_extracted = s; break; }
            }
          } else {
            const s = addrFromNode(jl);
            if (s) location_extracted = s;
          }
        }
      }
      if (description_html && date_posted_extracted && location_extracted) break;
    }
  } catch (e) {
    log.debug(`JSON-LD parse failed: ${e.message}`);
  }

  // DOM fallbacks
  if (!description_html) {
    const node = $('[data-ui="job-description"], [data-ui="job-content"], .job-description, .JobDetails__content').first();
    const html = node.html();
    if (html && html.trim()) description_html = html.trim();
  }
  if (!description_text && description_html) {
    try {
      const $$ = cheerioLoad(description_html);
      description_text = $$.text().replace(/\s+\n/g, '\n').replace(/\s{2,}/g, ' ').trim() || null;
    } catch {
      description_text = $('[data-ui="job-description"], [data-ui="job-content"], .JobDetails__content, .job-description').text().trim() || null;
    }
  }
  if (!description_text) {
    const txt = $('[data-ui="job-description"], [data-ui="job-content"], .JobDetails__content, .job-description').text().trim();
    if (txt) description_text = txt;
  }

  if (!location_extracted) {
    const locNode = $('[data-ui="job-location"], .job-stats, .JobDetails__meta').first();
    const locText = locNode.text().replace(/\s+/g, ' ').trim();
    if (locText) location_extracted = locText;
  }

  if (!date_posted_extracted) {
    const postedCandidate = $('*').filter((_, el) => /posted\s/i.test($(el).text())).first().text();
    const m = postedCandidate && postedCandidate.match(/posted\s+([^|•\n\r]+?)(?:\s+ago)?(?:\s|$)/i);
    if (m) date_posted_extracted = m[1].trim();
  }

  const job_types = extractJobTypes($);

  return {
    id: seed?.id || null,
    title: safeTitle || null,
    company: safeCompany || null,
    department: seed?.department || null,
    location: location_extracted || null,
    date_posted: date_posted_extracted ?? safeDateSeed ?? null,
    description_html: description_html || null,
    description_text: description_text || null,
    job_types: job_types || null,
    url,
  };
}

// ---------- Build seeds ----------
function buildSeedsFromStartUrl(userUrl, seedId) {
  const seeds = { listSeeds: [], detailSeeds: [] };
  if (!userUrl) return seeds;

  const limit = 100;

  if (isDetailUrl(userUrl)) {
    seeds.detailSeeds.push({
      url: userUrl,
      userData: { label: 'DETAIL', url: userUrl, seedId },
    });
    return seeds;
  }

  const api = normalizeListUrl(userUrl, limit, null);
  if (api) {
    seeds.listSeeds.push({
      url: api,
      userData: { label: 'LIST', seedId, page: 1 },
      options: { responseType: 'json' },
    });
  }
  return seeds;
}

function buildSeedsFromQueryInputs() {
  const seeds = [];
  const limit = 100;

  createdAtPasses.forEach((pass, index) => {
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword);
    if (location) params.set('location', location);
    if (pass) params.set('created_at', pass);
    params.set('limit', String(limit));

    seeds.push({
      url: `https://jobs.workable.com/api/v1/jobs?${params.toString()}`,
      userData: { label: 'LIST', seedId: `query-${index + 1}`, page: 1 },
      options: { responseType: 'json' },
    });
  });

  return seeds;
}

const sanitizedStartUrls = Array.isArray(startUrls)
  ? startUrls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)
  : [];

const aggregatedListSeeds = [];
const aggregatedDetailSeeds = [];

sanitizedStartUrls.forEach((url, index) => {
  const seedId = `start-${index + 1}`;
  const seeds = buildSeedsFromStartUrl(url, seedId);
  aggregatedListSeeds.push(...seeds.listSeeds);
  aggregatedDetailSeeds.push(...seeds.detailSeeds);
});

const shouldAddQuerySeeds = Boolean(keyword || location || aggregatedListSeeds.length === 0);
const listSeeds = [
  ...aggregatedListSeeds,
  ...(shouldAddQuerySeeds ? buildSeedsFromQueryInputs() : []),
];
const detailSeeds = aggregatedDetailSeeds;

for (const seed of detailSeeds) {
  if (!state.seen.has(seed.url)) state.seen.add(seed.url);
}

// ---------- Crawler ----------
const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  maxConcurrency: concurrency,
  requestHandlerTimeoutSecs: 60,
  navigationTimeoutSecs: 60,

  async requestHandler({ request, json, $, crawler }) {
    const userData = request.userData || {};
    const { label, seedId, page = 1 } = userData;

    if (label === 'LIST') {
      if (page > maxPagesLimit) {
        log.debug(`Skipping ${request.url} because it exceeds maxPagesLimit (${maxPagesLimit}).`);
        return;
      }

      if (!json || !Array.isArray(json.jobs)) {
        log.warning(`Invalid list payload for ${request.url}`);
        return;
      }

      const { jobs, nextPageToken } = json;

      log.info(`Processing page ${page} with ${jobs.length} jobs. Queued so far: ${state.queuedCount}/${targetResults}`);

      for (const job of jobs) {
        if (state.queuedCount >= targetResults) break;

        const detailUrl = job.url;
        if (!detailUrl || state.seen.has(detailUrl)) continue;
        state.seen.add(detailUrl);

        const detailUserData = {
          label: 'DETAIL',
          id: job.id || null,
          title: job.title || null,
          company: job.company?.title || null,
          department: job.department || null,
          location: job.location?.location_str || job.location?.city || null,
          date_posted: job.created || job.published_on || null,
          url: detailUrl,
          seedId: seedId || null,
          sourceListUrl: request.url,
        };

        await crawler.addRequests([{
          url: detailUrl,
          userData: detailUserData,
        }]);

        state.queuedCount++;
      }

      // Use nextPageToken for pagination
      if (nextPageToken && state.queuedCount < targetResults && page < maxPagesLimit) {
        const baseUrl = new URL(request.url);
        baseUrl.searchParams.set('pageToken', nextPageToken);

        log.info(`Continuing to next page (${page + 1}) using nextPageToken. Target: ${targetResults}, Queued: ${state.queuedCount}`);

        await crawler.addRequests([{
          url: baseUrl.toString(),
          userData: { label: 'LIST', seedId, page: page + 1 },
          options: { responseType: 'json' },
        }]);
      } else if (!nextPageToken) {
        log.info(`No more pages available (no nextPageToken). Queued: ${state.queuedCount} jobs.`);
      } else if (state.queuedCount >= targetResults) {
        log.info(`Reached target queue count (${targetResults}). Stopping pagination.`);
      } else if (page >= maxPagesLimit) {
        log.info(`Reached max pages limit (${maxPagesLimit}). Stopping pagination.`);
      }
    } else if (label === 'DETAIL') {
      if (state.collectedCount >= targetResults) {
        log.debug(`Skipping job detail - already reached target of ${targetResults} jobs`);
        return;
      }

      const result = extractDetailFields($, request.url, userData);
      await Actor.pushData(result);
      state.collectedCount++;

      if (state.collectedCount % 10 === 0 || state.collectedCount === targetResults) {
        log.info(`Progress: ${state.collectedCount}/${targetResults} jobs saved`);
      }
    }
  },

  async failedRequestHandler({ request }) {
    log.warning(`Request failed and reached max retries: ${request.url}`);
  },
});

// Seed requests
await crawler.addRequests([...listSeeds, ...detailSeeds]);

log.info(`Starting scraper. Target: ${targetResults} jobs, Concurrency: ${concurrency}`);

await crawler.run();

log.info(`Scraper finished. Saved ${state.collectedCount} items (target was ${targetResults}). Queued ${state.queuedCount} total.`);

await Actor.exit();
