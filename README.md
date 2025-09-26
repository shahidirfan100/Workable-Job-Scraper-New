# LinkedIn Jobs Scraper (HTTP + Cheerio, v3)
- Alpine build like your reference log. No Playwright. Uses Crawlee CheerioCrawler.
- Collects links via `jobs-guest` list endpoint. Fetches details via static HTML; if missing, tries guest detail endpoints.
- FIX: replaced `requestAsBrowser` import with `gotScraping` to avoid Crawlee export mismatch.
