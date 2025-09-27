// src/main.js
import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log } from 'crawlee';
import { gotScraping } from 'got-scraping'; // kept if you want to use later
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
  postedWithin = '7d',   // one of: '24h' | '7d' | '30d'
  results_wanted = 200,  // target number of SAVED items
  maxConcurrency = 5,
  proxyConfiguration = null,
} = input;

const apiDateFilter = dateMap[postedWithin] || null;

const state = {
  collectedCount: 0, // incremented AFTER Dataset.pushData in DETAIL
};

// ---------- Build the first API URL (with higher limit) ----------
const searchParams = new URLSearchParams();
if (keyword) searchParams.set('q', keyword);
if (location) searchParams.set('location', location);
if (apiDateFilter) searchParams.set('created_at', apiDateFilter);

// Workable supports limit (max ~100). Ask for as many as we still want, capped at 100.
const pageLimit = Math.min(results_wanted || 100, 100);
searchParams.set('limit', String(pageLimit));

const startUrl = `https://jobs.workable.com/api/v1/jobs?${searchParams.toString()}`;

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

// ---------- Helpers ----------
/** Extract job types from JSON-LD or visible tags */
function extractJobTypes($) {
  let job_types = null;

  try {
    // Prefer JSON-LD JobPosting.employmentType
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

    // Fallback: visible meta/tags/badges
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

  // 1) JSON-LD JobPosting: description, datePosted, jobLocation
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

  // 2) DOM selectors for description if JSON-LD missing
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
      description_text = $('[data-ui="job-description"], [data-ui="job-content"], .job-description, .JobDetails__content').text().trim() || null;
    }
  }
  if (!description_text) {
    const txt = $('[data-ui="job-description"], [data-ui="job-content"], .job-description, .JobDetails__content').text().trim();
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
      // Expect { jobs: [...], paging: { next: "https://jobs.workable.com/api/v1/jobs?..." } }
      if (!json || !Array.isArray(json.jobs)) {
        log.warning(`Invalid list payload for ${request.url}`);
        return;
      }

      const { jobs, paging } = json;

      for (const job of jobs) {
        // Stop scheduling new details if we already reached target
        if (state.collectedCount >= results_wanted) break;

        const detailUserData = {
          label: 'DETAIL',
          title: job.title,
          company: job.company?.title || null,
          location: job.location?.location_str || null,
          date_posted: job.published_on || null,
          url: job.url, // job view URL
        };

        await addRequests([{
          url: detailUserData.url,
          userData: detailUserData,
        }]);
      }

      // Follow next page if present and we still need more
      if (paging?.next && state.collectedCount < results_wanted) {
        log.info(`Enqueuing next list page: ${paging.next}`);
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

// Seed with the first list page (JSON)
await crawler.addRequests([{
  url: startUrl,
  userData: { label: 'LIST' },
  options: { responseType: 'json' },
}]);

await crawler.run();

log.info('Scraper finished.');
await Actor.exit();
