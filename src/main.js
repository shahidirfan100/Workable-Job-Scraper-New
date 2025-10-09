// src/main.js
import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log } from 'crawlee';
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
  keyword = input.query || '', // Support both 'keyword' and 'query'
  location = '',
  posted_date = input.timeRange || 'anytime', // Support both 'posted_date' and 'timeRange'
  results_wanted = input.maxJobs || 100, // Support both 'results_wanted' and 'maxJobs'
  maxPagesPerList = 25,
  maxConcurrency = 10,
  proxyConfiguration = null,
  cookies = [],
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

// Convert a non-API jobs.workable.com URL (with query string) to the API list URL
function toApiListUrlFromSearch(u, limit, createdAt = null) {
  const source = new URL(u);
  const params = new URLSearchParams(source.search);
  // Pass-through known query fields
  const api = new URL('https://jobs.workable.com/api/v1/jobs');
  // If original had query params, copy them; add created_at override if provided
  for (const [k, v] of params.entries()) api.searchParams.set(k, v);
  if (createdAt) api.searchParams.set('created_at', createdAt);
  api.searchParams.set('limit', String(limit));
  return api.toString();
}

// Normalize a user-provided list URL into an API URL (if possible)
function normalizeListUrl(userUrl, limit, createdAt = null) {
  if (!userUrl) return null;
  // API list URL: ensure it carries a limit (<=100)
  if (isApiListUrl(userUrl)) {
    const u = new URL(userUrl);
    if (!u.searchParams.get('limit')) u.searchParams.set('limit', String(limit));
    if (createdAt !== null) {
      // respect explicit created_at if provided
      u.searchParams.set('created_at', createdAt);
    }
    // Remove page param if present; paging is given by 'paging.next'
    u.searchParams.delete('page');
    return u.toString();
  }

  // Detail URL: we cannot turn it into list; caller should enqueue as DETAIL directly
  if (isDetailUrl(userUrl)) return null;

  // Non-API jobs.workable.com search/browse URL with query: convert to API
  if (isJobsHost(userUrl)) {
    return toApiListUrlFromSearch(userUrl, limit, createdAt);
  }

  // Unsupported hosts: return null; will fall back to query inputs
  return null;
}

function createCookieHeader(cookieInput) {
  if (!Array.isArray(cookieInput)) return '';
  const pairs = [];
  for (const cookie of cookieInput) {
    if (!cookie || typeof cookie !== 'object') continue;
    const { name, value } = cookie;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    const trimmedName = name.trim();
    if (!trimmedName) continue;
    pairs.push(`${trimmedName}=${value}`);
  }
  return pairs.join('; ');
}

// ---------- Date passes ----------
const createdAtPasses = buildCreatedAtPasses(posted_date);

// ---------- State ----------
const state = {
  collectedCount: 0,   // incremented AFTER save
  queuedCount: 0,      // incremented when detail URL is queued
  seen: new Set(),     // URL-level dedupe across pages & passes
};

// Handle proxy configuration - ensure it's not null to avoid destructuring error
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
    title: safeTitle || null,
    company: safeCompany || null,
    location: location_extracted || null,
    date_posted: date_posted_extracted ?? safeDateSeed ?? null,
    description_html: description_html || null,
    description_text: description_text || null,
    job_types: job_types || null,
    url,
  };
}

// ---------- Build seeds ----------

// If the user provided start URLs, normalize them.
//  - API list URL => use it
//  - jobs.workable.com search URL => convert to API list URL
//  - job detail URL => scrape it directly
function buildSeedsFromStartUrl(userUrl, seedId) {
  const seeds = { listSeeds: [], detailSeeds: [] };
  if (!userUrl) return seeds;

  const limit = 100; // Workable API max limit per request

  if (isDetailUrl(userUrl)) {
    seeds.detailSeeds.push({
      url: userUrl,
      userData: { label: 'DETAIL', url: userUrl, seedId },
    });
    return seeds;
  }

  // Try to normalize to API list URL; if fails, we return empty and let query inputs drive
  const api = normalizeListUrl(userUrl, limit, null /* don't force created_at on direct URLs */);
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
  const limit = 100; // Workable API max limit per request

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
const cookieHeader = createCookieHeader(cookies);

const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  maxConcurrency: concurrency,
  requestHandlerTimeoutSecs: 60,
  navigationTimeoutSecs: 60,
  preNavigationHooks: [
    async ({ request }) => {
      if (cookieHeader) {
        request.headers = request.headers || {};
        request.headers.Cookie = cookieHeader;
      }
    },
  ],

  async requestHandler({ request, json, $, addRequests }) {
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

      const { jobs, paging } = json;

      for (const job of jobs) {
        if (state.queuedCount >= targetResults) break;

        const detailUrl = job.url;
        if (!detailUrl || state.seen.has(detailUrl)) continue;
        state.seen.add(detailUrl);

        const detailUserData = {
          label: 'DETAIL',
          title: job.title || null,
          company: job.company?.title || null,
          location: job.location?.location_str || null,
          date_posted: job.published_on || null,
          url: detailUrl,
          seedId: seedId || null,
          sourceListUrl: request.url,
        };

        await addRequests([{
          url: detailUrl,
          userData: detailUserData,
        }]);
        
        state.queuedCount++;
      }

      if (paging?.next && state.queuedCount < targetResults && page < maxPagesLimit) {
        await addRequests([{
          url: paging.next,
          userData: { label: 'LIST', seedId, page: page + 1 },
          options: { responseType: 'json' },
        }]);
      }
    } else if (label === 'DETAIL') {
      // Only process if we haven't reached our target yet
      if (state.collectedCount >= targetResults) {
        log.debug(`Skipping job detail - already reached target of ${targetResults} jobs`);
        return;
      }
      
      const result = extractDetailFields($, request.url, userData);
      await Dataset.pushData(result);
      state.collectedCount++;
      log.debug(`Saved (${state.collectedCount}/${targetResults}): ${result.title} @ ${result.company}`);
    }
  },

  async failedRequestHandler({ request }) {
    log.warning(`Request failed and reached max retries: ${request.url}`);
  },
});
// Seed requests
await crawler.addRequests([...listSeeds, ...detailSeeds]);

await crawler.run();

log.info(`Scraper finished. Saved ${state.collectedCount} items (target was ${targetResults}).`);
await Actor.exit();
