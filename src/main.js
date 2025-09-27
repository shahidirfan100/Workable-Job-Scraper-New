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
        const { label, userData } = request.userData;

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

            const descriptionNode = $('[data-ui="job-description"]');
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
                title: userData.title,
                company: userData.company,
                location: userData.location,
                date_posted: userData.date_posted,
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