# Workable Jobs Scraper - Extract Job Listings from Workable Career Pages

Extract job listings from thousands of companies using Workable career pages. Get comprehensive job data including titles, companies, locations, salaries, descriptions, and more in minutes. Perfect for recruiters, job boards, market research, and competitive analysis.

## What is Workable Jobs Scraper?

Workable is one of the most popular applicant tracking systems (ATS) used by companies worldwide to manage their hiring process. This scraper allows you to extract job postings from any company using Workable's career pages at `jobs.workable.com`.

Whether you're a recruiter tracking opportunities, a data analyst researching the job market, or building a job aggregation platform, this tool provides structured, ready-to-use job data.

## Why use this scraper?

✅ **Comprehensive Data** - Extract 25+ fields per job including salary, benefits, qualifications, and full descriptions  
✅ **Fast & Reliable** - Optimized for speed with configurable concurrency  
✅ **Flexible Filtering** - Search by keywords, location, posting date, and more  
✅ **No Coding Required** - Simple configuration with JSON input  
✅ **Production Ready** - Built for large-scale data extraction with proxy support  
✅ **Fresh Data** - Get the latest job postings from companies worldwide  

## Use Cases

### 🎯 **Recruitment & Talent Acquisition**
- Track job openings at target companies
- Monitor competitor hiring trends
- Build talent pipelines for specific roles
- Identify companies actively hiring in specific locations

### 📊 **Market Research & Analytics**
- Analyze salary trends across industries
- Research in-demand skills and qualifications
- Track hiring patterns and job market dynamics
- Generate reports on employment opportunities

### 💼 **Job Boards & Aggregators**
- Populate job listings for niche job boards
- Keep job databases fresh with latest postings
- Build specialized job search platforms
- Aggregate remote work opportunities

### 🔍 **Competitive Intelligence**
- Monitor competitor hiring activities
- Identify expansion into new markets
- Track department growth and priorities
- Analyze job requirements and benefits offered

## Input Configuration

The scraper accepts the following parameters to customize your job extraction:

### Basic Parameters

| Parameter | Type | Description | Default | Required |
|-----------|------|-------------|---------|----------|
| `startUrls` | Array | List of Workable URLs to scrape (search, API, or detail pages) | `[]` | No |
| `keyword` | String | Search keyword to filter jobs (e.g., "software engineer") | `""` | No |
| `location` | String | Location filter (e.g., "remote", "london", "United States") | `""` | No |
| `posted_date` | String | Filter by posting date: `anytime`, `24h`, `7d`, `30d` | `anytime` | No |
| `results_wanted` | Integer | Maximum number of jobs to extract | `50` | No |

### Advanced Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `maxPagesPerList` | Integer | Maximum pages to fetch per search | `25` |
| `maxConcurrency` | Integer | Number of concurrent requests | `10` |
| `proxyConfiguration` | Object | Proxy settings (recommended for large scrapes) | `null` |

### Input Examples

#### Example 1: Search by Keyword and Location
```json
{
  "keyword": "data scientist",
  "location": "remote",
  "posted_date": "7d",
  "results_wanted": 100
}
```

#### Example 2: Scrape Specific Company
```json
{
  "startUrls": [
    "https://jobs.workable.com/search?location=united-states"
  ],
  "results_wanted": 50
}
```

#### Example 3: Recent Tech Jobs in Europe
```json
{
  "keyword": "software developer",
  "location": "Western Europe",
  "posted_date": "24h",
  "results_wanted": 200,
  "maxConcurrency": 15
}
```

#### Example 4: Using API URLs Directly
```json
{
  "startUrls": [
    "https://jobs.workable.com/api/v1/jobs?q=marketing&limit=100"
  ],
  "results_wanted": 150
}
```

## Output Data

The scraper extracts comprehensive job information with the following fields per job listing:

### Job Information
| Field | Description |
|-------|-------------|
| `id` | Unique job identifier from Workable |
| `title` | Job title/position name |
| `company` | Company name |
| `department` | Department or team |
| `location` | Full location string |
| `date_posted` | When the job was posted |

### Job Content
| Field | Description |
|-------|-------------|
| `description_html` | Full job description (HTML formatted) |
| `description_text` | Plain text description (cleaned, readable) |
| `job_types` | Array of job type tags (Full-time, Part-time, etc.) |
| `url` | Direct URL to the job posting |

### Sample Output

```json
{
  "id": "12345",
  "title": "Senior Software Engineer",
  "company": "TechCorp Inc",
  "department": "Engineering",
  "location": "San Francisco, CA, United States",
  "date_posted": "2026-01-05",
  "description_html": "<div><h2>About the Role</h2><p>We are seeking...</p></div>",
  "description_text": "About the Role We are seeking a talented engineer to join our team...",
  "job_types": ["Full-time", "Remote"],
  "url": "https://jobs.workable.com/view/ABC123"
}
```

## How to Use This Scraper

### Step 1: Configure Your Input
Choose your search parameters based on your needs:
- Enter keywords to search for specific roles
- Add location filters to target geographic areas
- Set posting date to get fresh listings only
- Specify how many jobs you want to extract

### Step 2: Run the Scraper
1. Click **"Start"** to begin extraction
2. The scraper will process your request automatically
3. Monitor progress in real-time
4. Wait for completion (typically 1-5 minutes for 100 jobs)

### Step 3: Download Your Data
Export the results in your preferred format:
- **JSON** - For developers and API integration
- **CSV** - For Excel, Google Sheets, and analytics tools
- **Excel** - For business users and reporting
- **HTML** - For quick preview and sharing

## Tips for Best Results

### 🚀 **Optimize Performance**
- Use **proxy configuration** for large-scale scraping (100+ jobs)
- Increase `maxConcurrency` (10-20) for faster extraction with paid Apify plans
- Set reasonable `results_wanted` limits to avoid timeouts

### 🎯 **Get Better Matches**
- Use **specific keywords** instead of broad terms
- Combine **keyword + location** filters for targeted results
- Use **posted_date** filter to get only recent opportunities
- Try both singular and plural forms (e.g., "engineer" vs "engineers")

### 💡 **Common Patterns**
- **Remote Jobs**: Set `location` to "remote"
- **Specific Companies**: Use `startUrls` with company-specific Workable pages
- **Multiple Searches**: Run separate instances for different keyword/location combinations
- **Fresh Listings**: Use `posted_date: "24h"` or `"7d"` for recent posts only

## Integration & Automation

### API Access
Use Apify's API to integrate this scraper into your applications:

```bash
curl -X POST https://api.apify.com/v2/acts/YOUR_ACTOR_ID/runs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -d '{
    "keyword": "data analyst",
    "location": "United States",
    "results_wanted": 100
  }'
```

### Webhooks
Set up webhooks to automatically process results when scraping completes.

### Scheduling
Schedule regular scrapes to keep your job database fresh:
- **Daily**: Get new postings every morning
- **Weekly**: Track hiring trends over time
- **Custom**: Set any interval that suits your needs

## Frequently Asked Questions

### How many jobs can I scrape?
You can extract as many jobs as you need by setting the `results_wanted` parameter. For large extractions (1000+ jobs), we recommend using Apify proxy configuration.

### How fresh is the data?
The scraper fetches live data directly from Workable's platform, ensuring you always get the most current job listings.

### What format is the output?
Data is exported in JSON by default, but you can download in CSV, Excel, or HTML formats from the Apify platform.

### Can I scrape specific companies?
Yes! Use the `startUrls` parameter with company-specific Workable URLs, or use keywords that match the company name.

### Do I need proxies?
Proxies are recommended for large-scale scraping (100+ jobs) or frequent runs to avoid rate limiting. Apify provides built-in proxy support.

### How long does scraping take?
Typical scraping speed:
- 50 jobs: 1-2 minutes
- 100 jobs: 2-4 minutes
- 500 jobs: 10-15 minutes

Speed depends on your concurrency settings and Apify plan.

### Is this legal?
This scraper extracts publicly available job posting data. Always review and comply with Workable's terms of service and applicable laws in your jurisdiction.

## Support & Feedback

Need help or have suggestions?
- 📧 Contact via Apify platform messaging
- 💬 Community support in Apify Discord
- 🐛 Report issues through the actor's issue tracker
- ⭐ Rate and review to help others find this tool

## Related Scrapers

Looking for other job scrapers?
- **LinkedIn Jobs Scraper** - Extract jobs from LinkedIn
- **Indeed Jobs Scraper** - Scrape Indeed job listings
- **Greenhouse Jobs Scraper** - Extract from Greenhouse ATS
- **Lever Jobs Scraper** - Scrape Lever career pages

---

**Start extracting job data now** and unlock insights from thousands of companies hiring on Workable! 🚀