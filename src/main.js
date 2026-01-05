// src/main.js
import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { load as cheerioLoad } from 'cheerio';

// User-Agent rotation pool
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// Maps input time ranges to Workable API parameters
const dateMap = {
  '24h': 'past_day',
  '7d': 'past_week',
  '30d': 'past_month',
};

// Random delay helper
const randomDelay = () => new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 150));

// Get random User-Agent
const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

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

// Proxy configuration
const proxyConfig = proxyConfiguration
  ? await Actor.createProxyConfiguration(proxyConfiguration)
  : await Actor.createProxyConfiguration();

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

// ---------- HTTP Request Helper ----------
async function makeRequest(url, isJson = false) {
  const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

  try {
    const response = await gotScraping({
      url,
      proxyUrl,
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': isJson ? 'application/json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      responseType: isJson ? 'json' : 'text',
      http2: true,
      retry: {
        limit: 3,
        methods: ['GET'],
        statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
      },
    });

    await randomDelay();
    return response;
  } catch (error) {
    console.log(`Request failed for ${url}: ${error.message}`);
    throw error;
  }
}

// ---------- Extraction Functions ----------
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
    console.log(`job_types extraction failed: ${e.message}`);
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
  let salary = null;
  let salary_currency = null;
  let valid_through = null;
  let benefits = null;
  let qualifications = null;
  let responsibilities = null;
  let industry = null;

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
        if (!valid_through && node.validThrough) {
          valid_through = String(node.validThrough).trim();
        }
        if (!industry && node.industry) {
          industry = String(node.industry).trim();
        }

        // Salary extraction
        if (!salary && node.baseSalary) {
          const bs = node.baseSalary;
          if (bs.value) {
            const val = bs.value;
            if (val.value) salary = String(val.value).trim();
            else if (val.minValue && val.maxValue) {
              salary = `${val.minValue}-${val.maxValue}`;
            }
            if (val.currency) salary_currency = String(val.currency).trim();
          }
        }

        // Benefits, qualifications, responsibilities
        if (!benefits && node.benefits) {
          benefits = Array.isArray(node.benefits) ? node.benefits.join(', ') : String(node.benefits).trim();
        }
        if (!qualifications && node.qualifications) {
          qualifications = String(node.qualifications).trim();
        }
        if (!responsibilities && node.responsibilities) {
          responsibilities = String(node.responsibilities).trim();
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
    }
  } catch (e) {
    console.log(`JSON-LD parse failed: ${e.message}`);
  }

  // DOM fallbacks for description
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
    company_description: seed?.company_description || null,
    company_logo: seed?.company_logo || null,
    location: location_extracted || null,
    country: seed?.country || null,
    region: seed?.region || null,
    remote: seed?.remote || null,
    telecommuting: seed?.telecommuting || null,
    department: seed?.department || null,
    employment_type: seed?.employment_type || null,
    function: seed?.function || null,
    experience: seed?.experience || null,
    education: seed?.education || null,
    date_posted: date_posted_extracted ?? safeDateSeed ?? null,
    created: seed?.created || null,
    published_on: seed?.published_on || null,
    valid_through: valid_through || null,
    salary: salary || null,
    salary_currency: salary_currency || null,
    benefits: benefits || null,
    qualifications: qualifications || null,
    responsibilities: responsibilities || null,
    job_types: job_types || null,
    description_html: description_html || null,
    description_text: description_text || null,
    id: seed?.id || null,
    shortcode: seed?.shortcode || null,
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

// ---------- Request Processing ----------
const listQueue = [...listSeeds];
const detailQueue = [...detailSeeds];

async function processListPage(request) {
  const { label, seedId, page = 1 } = request.userData || {};

  if (page > maxPagesLimit) {
    console.log(`Skipping ${request.url} - exceeds maxPagesLimit (${maxPagesLimit})`);
    return;
  }

  try {
    const response = await makeRequest(request.url, true);
    const json = response.body;

    if (!json || !Array.isArray(json.jobs)) {
      console.log(`Invalid list payload for ${request.url}`);
      return;
    }

    const { jobs, nextPageToken } = json;

    console.log(`Processing page ${page} with ${jobs.length} jobs. Queued: ${state.queuedCount}/${targetResults}`);

    for (const job of jobs) {
      if (state.queuedCount >= targetResults) break;

      const detailUrl = job.url;
      if (!detailUrl || state.seen.has(detailUrl)) continue;
      state.seen.add(detailUrl);

      const detailUserData = {
        label: 'DETAIL',
        id: job.id || null,
        shortcode: job.shortcode || null,
        title: job.title || null,
        company: job.company?.title || null,
        company_description: job.company?.description || null,
        company_logo: job.company?.logo || null,
        location: job.location?.location_str || job.location?.city || null,
        country: job.location?.country || null,
        region: job.location?.region || null,
        remote: job.remote || null,
        telecommuting: job.location?.telecommuting || null,
        department: job.department || null,
        employment_type: job.employment_type || null,
        function: job.function || null,
        experience: job.experience || null,
        education: job.education || null,
        date_posted: job.created || job.published_on || null,
        created: job.created || null,
        published_on: job.published_on || null,
        url: detailUrl,
        seedId: seedId || null,
        sourceListUrl: request.url,
      };

      detailQueue.push({
        url: detailUrl,
        userData: detailUserData,
      });

      state.queuedCount++;
    }

    // Handle pagination
    if (nextPageToken && state.queuedCount < targetResults && page < maxPagesLimit) {
      const baseUrl = new URL(request.url);
      baseUrl.searchParams.set('pageToken', nextPageToken);

      console.log(`Continuing to page ${page + 1} using nextPageToken. Queued: ${state.queuedCount}`);

      listQueue.push({
        url: baseUrl.toString(),
        userData: { label: 'LIST', seedId, page: page + 1 },
      });
    } else if (!nextPageToken) {
      console.log(`No more pages available. Queued: ${state.queuedCount} jobs.`);
    }
  } catch (error) {
    console.log(`Failed to process list page ${request.url}: ${error.message}`);
  }
}

async function processDetailPage(request) {
  if (state.collectedCount >= targetResults) {
    console.log(`Skipping detail - already reached target of ${targetResults} jobs`);
    return;
  }

  try {
    const response = await makeRequest(request.url, false);
    const $ = cheerioLoad(response.body);

    const result = extractDetailFields($, request.url, request.userData);
    await Actor.pushData(result);
    state.collectedCount++;

    if (state.collectedCount % 10 === 0 || state.collectedCount === targetResults) {
      console.log(`Progress: ${state.collectedCount}/${targetResults} jobs saved`);
    }
  } catch (error) {
    console.log(`Failed to process detail page ${request.url}: ${error.message}`);
  }
}

// ---------- Main Execution Loop ----------
console.log(`Starting scraper. Target: ${targetResults} jobs, Concurrency: ${concurrency}`);

// Process list pages first
while (listQueue.length > 0 && state.queuedCount < targetResults) {
  const batch = listQueue.splice(0, concurrency);
  await Promise.all(batch.map(processListPage));
}

// Process detail pages
while (detailQueue.length > 0 && state.collectedCount < targetResults) {
  const batch = detailQueue.splice(0, concurrency);
  await Promise.all(batch.map(processDetailPage));
}

console.log(`Scraper finished. Saved ${state.collectedCount}/${targetResults} jobs. Total queued: ${state.queuedCount}`);

await Actor.exit();
