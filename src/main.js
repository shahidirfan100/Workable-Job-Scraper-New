import { Actor } from 'apify';
import { CheerioCrawler, Dataset, log, Configuration } from 'crawlee';
import { gotScraping } from 'got-scraping';

// Maps input time ranges to Workable API parameters
const dateMap = {
    '24h': 'past_day',
    '7d': 'past_week',
    '30d': 'past_month',
};

await Actor.init();

const input = await Actor.getInput() || {};
const {
    keyword,
    location,
    posted_date = 'anytime',
    results_wanted = 50,
    maxConcurrency = 10,
    proxyConfiguration,
} = input;

if (!keyword) {
    throw new Error('Input "keyword" is required.');
}

// Global state to track collected jobs
const state = await Actor.useState('STATE', { collectedCount: 0 });

// Construct the initial API URL for job listings
const searchParams = new URLSearchParams({
    query: keyword,
    location: location || '',
    pageSize: 50, // Max supported by API
});

// Only add the 'created_at' parameter if a valid time range is selected.
const apiDateFilter = dateMap[posted_date];
if (apiDateFilter) {
    searchParams.set('created_at', apiDateFilter);
}

const startUrl = `https://jobs.workable.com/api/v1/jobs?${searchParams.toString()}`;

const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);

const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxConcurrency,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 60,

    async requestHandler({ request, json, $, enqueueLinks, addRequests }) {
        const userData = request.userData || {};
        const { label } = userData;

        if (label === 'LIST') {
            // This is a page from the Workable jobs API
            log.info(`Processing job list page...`);

            if (!json || !Array.isArray(json.jobs)) {
                log.warning('Received invalid data from API. Aborting this list page.');
                return;
            }

            const { jobs, nextPage } = json;
            const newJobs = [];

            for (const job of jobs) {
                if (state.collectedCount >= results_wanted) break;

                // The API provides some data, which we pass to the detail request
                const detailUserData = {
                    label: 'DETAIL',
                    title: job.title,
                    company: job.company.title,
                    location: job.location.location_str,
                    date_posted: job.published_on,
                    url: job.url, // Use the job view URL provided by the API
                };

                // Enqueue the detail page for full scraping
                await addRequests([{
                    url: detailUserData.url,
                    userData: detailUserData,
                }]);

                state.collectedCount++;
                newJobs.push(detailUserData.url);
            }

            log.info(`Enqueued ${newJobs.length} new job details. Total collected: ${state.collectedCount}/${results_wanted}`);

            // Paginate to the next API page if needed
            if (nextPage && state.collectedCount < results_wanted) {
                const nextUrl = new URL(request.url);
                nextUrl.searchParams.set('page', nextPage);
                log.info(`Enqueuing next list page: ${nextUrl.toString()}`);
                await addRequests([{
                    url: nextUrl.toString(),
                    userData: { label: 'LIST' },
                }]);
            }
        } else if (label === 'DETAIL') {
            // This is a job detail page
            log.info(`Scraping job detail: ${request.url}`);
            // Fallbacks in case userData is missing or partial (e.g., retries without metadata)
            const titleFallback = $('[data-ui="job-title"]').first().text().trim() || $('h1').first().text().trim() || null;
            const companyFallback = $('[data-ui="company-name"]').first().text().trim()
                || $('[itemprop="hiringOrganization"]').text().trim()
                || $('[rel="author"]').first().text().trim()
                || null;
            const locationFallback = $('[data-ui="job-location"]').first().text().trim()
                || $('[itemprop="jobLocation"]').text().trim()
                || $('.job-stats, .JobDetails__meta').find('li:contains("Location")').next().text().trim()
                || null;

            const safeTitle = userData.title ?? titleFallback;
            const safeCompany = userData.company ?? companyFallback;
            const safeLocation = userData.location ?? locationFallback;
            const safeDate = userData.date_posted ?? null;


            
            // Attempt multiple strategies to get description, date_posted, and location
            let description_html = null;
            let description_text = null;
            let date_posted_extracted = null;
            let location_extracted = safeLocation;

            // 1) JSON-LD JobPosting (most reliable for description/date/location)
            try {
                const ldNodes = $('script[type="application/ld+json"]');
                for (let i = 0; i < ldNodes.length; i++) {
                    const raw = $(ldNodes[i]).contents().text().trim();
                    if (!raw) continue;
                    let data;
                    try { data = JSON.parse(raw); } catch (_) { continue; }
                    const items = Array.isArray(data) ? data : [data];
                    for (const node of items) {
                        if (!node) continue;
                        const type = node['@type'];
                        const isJob = Array.isArray(type) ? type.includes('JobPosting') : type === 'JobPosting';
                        if (!isJob) continue;

                        if (!description_html && node.description) {
                            description_html = String(node.description).trim() || null;
                        }
                        if (!date_posted_extracted && node.datePosted) {
                            date_posted_extracted = String(node.datePosted).trim();
                        }
                        if (!location_extracted) {
                            // jobLocation may be object, array, or string
                            const jl = node.jobLocation;
                            const toStr = (x) => (x == null ? '' : String(x).trim());
                            const joinParts = (parts) => parts.filter(Boolean).join(', ') || null;
                            const addrFromNode = (n) => {
                                if (!n) return null;
                                if (typeof n === 'string') return n.trim();
                                // typical schema: { "@type":"Place", "address": { "@type":"PostalAddress", "addressLocality": "...", "addressRegion":"...", "addressCountry":"..." } }
                                const addr = n.address || n;
                                if (typeof addr === 'string') return addr.trim();
                                return joinParts([
                                    toStr(addr.addressLocality),
                                    toStr(addr.addressRegion),
                                    toStr(addr.addressCountry),
                                ]);
                            };
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

            // 2) DOM selectors fallbacks for description
            if (!description_html) {
                const node = $('[data-ui="job-description"], [data-ui="job-content"], .job-description, .JobDetails__content').first();
                const html = node.html();
                if (html && html.trim()) description_html = html.trim();
            }
            if (!description_text && description_html) {
                try {
                    const $$ = load(description_html);
                    description_text = $$.text().trim() || null;
                } catch (_) {
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
                const locText = locNode.text().replace(/\s+/g,' ').trim();
                if (locText) location_extracted = locText;
            }

            // 4) Relative posted text fallback (e.g., "Posted 3 days ago")
            if (!date_posted_extracted) {
                const postBits = $('*').filter((_, el) => /posted\s/i.test($(el).text())).first().text();
                const m = postBits && postBits.match(/posted\s+(.*?)(ago)?/i);
                if (m) date_posted_extracted = m[1].trim();
            }
// replaced above with robust extraction
            const description_html = descriptionNode.html()?.trim() || null;
            const description_text = descriptionNode.text()?.trim() || null;

            
            // Try to extract job types / employment type
            let job_types = null;
            try {
                // Prefer structured data if available
                const ldNodes = $('script[type="application/ld+json"]');
                for (let i = 0; i < ldNodes.length; i++) {
                    try {
                        const jsonText = $(ldNodes[i]).contents().text().trim();
                        if (!jsonText) continue;
                        const data = JSON.parse(jsonText);
                        const nodes = Array.isArray(data) ? data : [data];
                        for (const node of nodes) {
                            if (!node) continue;
                            // Look for a JobPosting object
                            if ((node['@type'] && (node['@type'] === 'JobPosting' || (Array.isArray(node['@type']) && node['@type'].includes('JobPosting'))))) {
                                const et = node.employmentType;
                                if (et) {
                                    if (Array.isArray(et)) {
                                        job_types = et.map(x => String(x).trim()).filter(Boolean);
                                    } else {
                                        job_types = [String(et).trim()].filter(Boolean);
                                    }
                                    break;
                                }
                            }
                        }
                        if (job_types) break;
                    } catch (e) { /* ignore parse errors */ }
                }

                // Fallback: look for common labels on the page
                if (!job_types) {
                    const candidates = [];
                    // Workable often shows job tags near the header/meta
                    $('[data-ui="job-meta"], [data-ui="job-tags"], .JobDetails__tags, .job-stats, .job-badges').find('li,span,a').each((_, el) => {
                        const t = $(el).text().trim();
                        if (/full[-\s]?time|part[-\s]?time|contract|temporary|internship|freelance|remote/i.test(t)) {
                            candidates.push(t);
                        }
                    });
                    // Deduplicate
                    job_types = [...new Set(candidates)].length ? [...new Set(candidates)] : null;
                }
            } catch (e) {
                log.debug(`job_types extraction failed: ${e.message}`);
            }
const result = {
                title: safeTitle,
                company: safeCompany,
                location: (location_extracted ?? safeLocation) || null,
                date_posted: date_posted_extracted ?? safeDate,
                description_html,
                description_text,
                job_types,
                url: request.url,
            };

            await Dataset.pushData(result);
            log.debug(`Saved item: ${result.title} at ${result.company}`);
        }
    },

    async failedRequestHandler({ request }) {
        log.warning(`Request failed, retrying: ${request.url} (retries: ${request.retryCount})`);
    },
});

log.info('Starting scraper for Workable...');
log.info(`Search URL: ${startUrl}`);
log.info(`Scraping up to ${results_wanted} jobs.`);

// Kick off the crawl with the first API list page
await crawler.addRequests([{
    url: startUrl,
    userData: { label: 'LIST' },
    // Use gotScraping for the initial request to get JSON
    // CheerioCrawler will parse it automatically if content-type is application/json
    options: {
        responseType: 'json',
    },
}]);

await crawler.run();

log.info('Scraper finished.');

await Actor.exit();