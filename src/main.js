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
  keyword = '',
  location = '',
  postedWithin = '7d',     // '24h' | '7d' | '30d' | (anything falsy = no date filter)
  results_wanted = 200,    // precise target of SAVED items
  maxConcurrency = 5,
  proxyConfiguration = null,
  // set to false if you don't want to auto-broaden time ranges
  expandDateWhenInsufficient = true,
} = input;

// Build the sequence of date filters to try, from strict → broad
function buildCreatedAtPasses(postedWithin) {
  const start = dateMap[postedWithin] || null;
  if (!expandDateWhenInsufficient) {
    return [start]; // just one pass (possibly null)
  }
  // Progressive broadening based on the initial choice
  if (start === 'past_day') return ['past_day', 'past_week', 'past_month', null];
  if (start === 'past_week') return ['past_week', 'past_month', null];
  if (start === 'past_month') return ['past_month', null];
  // if no initial filter
  return [null];
}
const createdAtPasses = buildCreatedAtPasses(postedWithin);

// Global state
const state = {
  collectedCount: 0,       // incremented AFTER save
  seen: new Set(),         // job URL dedupe across pages & passes
};

// Create proxy
const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

// ---------- Helpers ----------
/** Extract job types from JSON-LD or visible tags */
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
            ? et.map((x) => String(x).trim()).filter(Boolean)
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

/** Extract description (HTML/text), date_posted, and location */
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

  // 1) JSON-LD JobPosting
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

  // 2) DOM fallbacks for description
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

  // 3) DOM fallback for location
  if (!location_extracted) {
    const locNode = $('[data-ui="job-location"], .job-stats, .JobDetails__meta').first();
    const locText = locNode.text().replace(/\s+/g, ' ').trim();
    if (locText) location_extracted = locText;
  }

  // 4) Fallback for relative "Posted ..." strings
  if (!date_posted_extracted) {
    const postedCandidate = $('*').filter((_, el) => /posted\s/i.test($(el).text())).first().text();
    const m = postedCandidate && postedCandidate.match(/posted\s+([^|•\n\r]+?)(?:\s+ago)?(?:\s|$)/i);
    if (m) date_posted_extracted = m[1].trim();
  }

  // Job types
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

// Build initial LIST seeds for each created_at pass (strict → broad)
function buildListSeedUrls() {
  const urls = [];
  for (const pass of createdAtPasses) {
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword);
    if (location) params.set('location', location);
    if (pass) params.set('created_at', pass);

    // ask for as many as we still want (but Workable caps at 100)
    const pageLimit = Math.min(results_wanted || 100, 100);
    params.set('limit', String(pageLimit));

    urls.push(`https://jobs.workable.com/api/v1/jobs?${params.toString()}`);
  }
  return urls;
}

const listSeeds = buildListSeedUrls();

// ---------- Crawler ----------
const crawler = new CheerioCrawler({
  proxyConfiguration: proxyConfig,
  maxConcurrency,
  requestHandlerTimeoutSecs: 60,
  navigationTimeoutSecs: 60,

  async requestHandler({ request, json, $, addRequests }) {
    const userData = request.userData || {};
    const { label } = userData;

    if (label === 'LIST') {
      // Expect { jobs: [...], paging: { next: "..." } }
      if (!json || !Array.isArray(json.jobs)) {
        log.warning(`Invalid list payload for ${request.url}`);
        return;
      }

      const { jobs, paging } = json;

      for (const job of jobs) {
        if (state.collectedCount >= results_wanted) break;

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
        };

        await addRequests([{
          url: detailUrl,
          userData: detailUserData,
        }]);
      }

      // Follow next page if API provides it AND we still need more
      if (paging?.next && state.collectedCount < results_wanted) {
        await addRequests([{
          url: paging.next,
          userData: { label: 'LIST' },
          options: { responseType: 'json' },
        }]);
      }
    } else if (label === 'DETAIL') {
      // Scrape detail page
      const result = extractDetailFields($, request.url, userData);
      await Dataset.pushData(result);
      state.collectedCount++;
      log.debug(`Saved (${state.collectedCount}/${results_wanted}): ${result.title} @ ${result.company}`);
    }
  },

  async failedRequestHandler({ request }) {
    log.warning(`Request failed and reached max retries: ${request.url}`);
  },
});

// Seed all passes (strict → broad). Dedupe by state.seen and stop automatically
// once results_wanted is reached. If fewer exist, we simply exhaust all pages/passes.
await crawler.addRequests(
  listSeeds.map((url) => ({
    url,
    userData: { label: 'LIST' },
    options: { responseType: 'json' },
  })),
);

await crawler.run();

log.info(`Scraper finished. Saved ${state.collectedCount} items (target was ${results_wanted}).`);
await Actor.exit();
