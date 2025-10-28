# Workable Job Scraper

## Description

The Workable Job Scraper is a powerful tool designed to extract job listings from companies using Workable's career pages. It provides a streamlined way to gather essential job data, including job titles, company names, locations, and direct links to job postings. This actor is ideal for recruiters, data analysts, developers, and job seekers who need quick access to structured job market information.

Whether you're tracking openings at specific companies, conducting market research, or building a job board, this scraper delivers clean, minimal datasets without unnecessary complexity.

## Input

The actor accepts the following input parameters to customize the scraping process:

- **query** (string): Optional search query to filter jobs by keywords (e.g., "software engineer").
- **location** (string): Geographic filter for job locations (e.g., "Western Europe", "United States").
- **timeRange** (string): Time frame for job postings (e.g., "24h" for last 24 hours, "7d" for last 7 days).
- **maxJobs** (number): Maximum number of jobs to scrape (default: 150).
- **collectOnly** (boolean): If true, only collect job data without processing (default: false).
- **maxConcurrency** (number): Number of concurrent requests for faster scraping (default: 5).
- **proxyConfiguration** (object): Proxy settings for enhanced anonymity and reliability (optional).

Example input JSON:
```json
{
  "query": "data analyst",
  "location": "United States",
  "timeRange": "7d",
  "maxJobs": 100,
  "collectOnly": false,
  "maxConcurrency": 10,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

## Output

The actor outputs a dataset with the following fields for each scraped job:

- **jobTitle** (string): The title of the job position.
- **companyName** (string): The name of the hiring company.
- **location** (string): Job location details (city, state, country).
- **jobUrl** (string): Direct URL to the job posting on Workable.

Example output item:
```json
{
  "jobTitle": "Senior Software Engineer",
  "companyName": "TechCorp",
  "location": "San Francisco, CA, USA",
  "jobUrl": "https://apply.workable.com/techcorp/j/12345/"
}
```

## Usage

### Basic Usage
1. Provide the URL of a Workable career page or configure filters via input parameters.
2. Run the actor on the Apify platform.
3. Download the resulting dataset in JSON, CSV, or other formats.

### Example Scenarios
- **Track Jobs at a Company**: Set the `query` to a specific role and `location` to target regions.
- **Bulk Data Collection**: Increase `maxJobs` and `maxConcurrency` for larger datasets.
- **Filtered Searches**: Use `timeRange` to focus on recent postings.

### Running the Actor
To run this actor:
1. Go to the Apify Console.
2. Search for "Workable Job Scraper".
3. Configure inputs as needed.
4. Start the run and monitor progress.
5. Export results once complete.

## Configuration

- **Proxy Settings**: Enable proxies via `proxyConfiguration` to avoid IP blocks during large-scale scraping.
- **Concurrency**: Adjust `maxConcurrency` based on your Apify plan limits to optimize speed.
- **Data Limits**: Set `maxJobs` to control output size and processing time.

For advanced configurations, refer to Apify's documentation on actor inputs and proxy usage.

## Support

If you encounter issues or need assistance, please check the Apify Community forums or contact support through the Apify platform.