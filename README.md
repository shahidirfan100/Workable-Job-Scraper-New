# Workable Jobs Scraper (HTTP + Cheerio)
- Alpine build like your reference log. No Playwright. Uses Crawlee CheerioCrawler.
- Collects job listings via the official Workable JSON API (`/api/v1/jobs`). Fetches details from the static HTML of each job page.
- FIX: replaced `requestAsBrowser` import with `gotScraping` to avoid Crawlee export mismatch.
