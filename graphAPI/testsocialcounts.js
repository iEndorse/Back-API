const express = require('express');
const puppeteer = require('puppeteer-core');
const sql = require('mssql');
const multer = require('multer');
const upload = multer();
const fs = require('fs').promises; // To save HTML content to file
const path = require('path');    // To construct file paths
const router = express.Router();

// --- Helper Functions ---

// Utility function for delays
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility to parse shorthand numbers like "1.2K", "3.5M"
function parseCount(text) {
  if (!text) return 0;
  const cleanedText = String(text).replace(/,/g, '').trim(); // Ensure it's a string and clean it
  const match = cleanedText.match(/^([\d.]+)([KMB]?)\b/i); // Match K, M, B suffixes

  if (!match) {
    // Try parsing as a plain number if no suffix found
    const plainNum = parseInt(cleanedText, 10);
    return isNaN(plainNum) ? 0 : plainNum;
  }

  const num = parseFloat(match[1]);
  const suffix = match[2] ? match[2].toUpperCase() : '';

  if (isNaN(num)) return 0;

  switch (suffix) {
    case 'K':
      return Math.round(num * 1_000);
    case 'M':
      return Math.round(num * 1_000_000);
    case 'B':
      return Math.round(num * 1_000_000_000);
    default:
      return Math.round(num);
  }
}


// Generate a random user agent
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.78'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// --- Platform Specific Extraction Logic ---

async function extractFacebookMetrics(page) {
  const data = { likes: 0, comments: 0, shares: 0, views: 0 };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); // For unique filenames
    const htmlLogFile = path.join(__dirname, `debug-fb-html-${timestamp}.html`); // Save in script's directory
    const screenshotFile = path.join(__dirname, `debug-fb-screenshot-${timestamp}.png`);

    console.log('Attempting to extract Facebook metrics (v6 - HTML Capture Focus)...');
    const postUrl = page.url();

    try {
        // --- Wait Strategy (Simplified) ---
        console.log('Waiting for body element...');
        await page.waitForSelector('body', { timeout: 20000 });
        console.log('Body element found. Waiting additional time for dynamic content...');
        await delay(8000); // **Longer fixed delay** to allow JS rendering attempts

    } catch (waitError) {
        console.warn(`Could not find body or timeout waiting: ${waitError.message}. Attempting to continue...`);
        // Still try to capture HTML/Screenshot even if wait fails
    }

    // --- Capture HTML and Screenshot BEFORE Evaluation ---
    let htmlContent = '';
    try {
        console.log('Capturing page content...');
        htmlContent = await page.content();
        await fs.writeFile(htmlLogFile, htmlContent);
        console.log(`HTML content saved to: ${htmlLogFile}`);

        console.log('Taking screenshot...');
        await page.screenshot({ path: screenshotFile, fullPage: true }); // Full page screenshot
        console.log(`Screenshot saved to: ${screenshotFile}`);

    } catch (captureError) {
        console.error(`Error capturing HTML/Screenshot: ${captureError.message}`);
    }

  // --- Try extracting metrics using different methods ---

  // Method 1: Evaluate in page context (more robust for complex structures)
  try {
    const metrics = await page.evaluate(() => {
      const result = { likes: 0, comments: 0, shares: 0, views: 0 };

      // Helper inside evaluate
      const parseCountEval = (text) => {
         if (!text) return 0;
          const cleanedText = String(text).replace(/,/g, '').trim();
          const match = cleanedText.match(/^([\d.]+)([KMB]?)\b/i);
          if (!match) {
            const plainNum = parseInt(cleanedText, 10);
            return isNaN(plainNum) ? 0 : plainNum;
          }
          const num = parseFloat(match[1]);
          const suffix = match[2] ? match[2].toUpperCase() : '';
          if (isNaN(num)) return 0;
          switch (suffix) {
            case 'K': return Math.round(num * 1_000);
            case 'M': return Math.round(num * 1_000_000);
            case 'B': return Math.round(num * 1_000_000_000);
            default: return Math.round(num);
          }
      };

      // --- LIKES ---
      // Try finding reaction counts (summing different types might be needed)
      // Selector needs careful inspection of the *current* FB layout for video shares
      // Example selector (likely needs adjustment):
      const reactionButton = document.querySelector('[role="button"] span[aria-label*="reactions"]');
      if (reactionButton) {
        // Sometimes the count is in a sibling or parent span
        const countSpan = reactionButton.closest('span')?.querySelector('span:not([aria-label])'); // Look for a span without aria-label nearby
         if (countSpan && countSpan.innerText) {
             result.likes = parseCountEval(countSpan.innerText);
         } else if (reactionButton.innerText) { // Fallback to the button itself
             result.likes = parseCountEval(reactionButton.innerText);
         }
      }
       // Alternative selector if the above fails
       if (result.likes === 0) {
         const likeElement = document.querySelector('[data-testid="UFI2ReactionsCount/root"] span'); // Older selector
         if (likeElement) result.likes = parseCountEval(likeElement.innerText);
       }
       // Another attempt based on text patterns within specific elements
       if (result.likes === 0) {
           document.querySelectorAll('span').forEach(span => {
               if (span.innerText.match(/^[0-9.,]+[KMB]?$/) && (span.ariaLabel?.includes('Like') || span.ariaLabel?.includes('reaction'))) {
                   result.likes = Math.max(result.likes, parseCountEval(span.innerText));
               }
           });
       }


      // --- COMMENTS ---
      // Example selector (likely needs adjustment): Find a link/button indicating comments
      const commentLink = Array.from(document.querySelectorAll('span')).find(el => el.innerText.match(/([\d.,]+[KMB]?)\s+comment/i));
      if (commentLink) {
        result.comments = parseCountEval(commentLink.innerText.match(/([\d.,]+[KMB]?)/)[0]);
      }
      // Alternative specific selector (check dev tools)
      // const commentElement = document.querySelector('[data-testid="UFI2CommentCount/root"] span');
      // if (!result.comments && commentElement) result.comments = parseCountEval(commentElement.innerText);


      // --- SHARES ---
       // Example selector (likely needs adjustment): Find a link/button indicating shares
      const shareLink = Array.from(document.querySelectorAll('span')).find(el => el.innerText.match(/([\d.,]+[KMB]?)\s+share/i));
      if (shareLink) {
        result.shares = parseCountEval(shareLink.innerText.match(/([\d.,]+[KMB]?)/)[0]);
      }

      // --- VIEWS (Often harder on FB posts, more common on videos/reels) ---
      // Example selector (likely needs adjustment): Look for "views" text
       const viewSpan = Array.from(document.querySelectorAll('span')).find(el => el.innerText.match(/([\d.,]+[KMB]?)\s+view/i));
        if (viewSpan) {
            result.views = parseCountEval(viewSpan.innerText.match(/([\d.,]+[KMB]?)/)[0]);
        }
         // Sometimes views are near the video player timestamp or metadata area
        // const viewElement = document.querySelector('.some-video-metadata-class span'); // Needs inspection
        // if (!result.views && viewElement && viewElement.innerText.includes('views')) {
        //      result.views = parseCountEval(viewElement.innerText);
        // }


      return result;
    });
    console.log('Metrics extracted via page.evaluate:', metrics);
    data.likes = metrics.likes || 0;
    data.comments = metrics.comments || 0;
    data.shares = metrics.shares || 0;
    data.views = metrics.views || 0;

  } catch (evalError) {
    console.error('Error during page.evaluate for Facebook metrics:', evalError.message);
  }

  // Method 2: Fallback using broad text search (less reliable)
  // Only use this if evaluate fails significantly
  if (data.likes === 0 && data.comments === 0 && data.shares === 0 && data.views === 0) {
    console.log('Falling back to body text matching for Facebook.');
    try {
        const bodyText = await page.evaluate(() => document.body.innerText);
        const likeMatches = bodyText.match(/([\d.,]+[KMB]?)\s*(like|reaction)/i);
        const commentMatches = bodyText.match(/([\d.,]+[KMB]?)\s+comment/i);
        const shareMatches = bodyText.match(/([\d.,]+[KMB]?)\s+share/i);
        const viewMatches = bodyText.match(/([\d.,]+[KMB]?)\s+view/i); // For videos

        if (likeMatches) data.likes = parseCount(likeMatches[1]);
        if (commentMatches) data.comments = parseCount(commentMatches[1]);
        if (shareMatches) data.shares = parseCount(shareMatches[1]);
        if (viewMatches) data.views = parseCount(viewMatches[1]);
        console.log('Metrics from body text match:', data);
    } catch (textMatchError) {
        console.error('Error during body text matching:', textMatchError.message);
    }
  }


  return data;
}


async function extractTikTokMetrics(page) {
  const data = { likes: 0, comments: 0, shares: 0, views: 0 };
  console.log('Attempting to extract TikTok metrics...');
  try {
    // TikTok selectors seem more stable, but still worth wrapping in waits/catches
    const likeSelector = '[data-e2e="like-count"]';
    const commentSelector = '[data-e2e="comment-count"]';
    const shareSelector = '[data-e2e="share-count"]';
    // TikTok View selector might vary - inspect element needed
    // const viewSelector = '[data-e2e="view-count"]'; // Example, check actual page

    await page.waitForSelector(likeSelector, { timeout: 15000 });
    console.log('Found TikTok like count element.');

    data.likes = parseCount(await page.$eval(likeSelector, el => el.innerText));
    data.comments = parseCount(await page.$eval(commentSelector, el => el.innerText));
    data.shares = parseCount(await page.$eval(shareSelector, el => el.innerText));

    // Try finding views
    // try {
    //   await page.waitForSelector(viewSelector, { timeout: 5000 }); // Shorter timeout as it might not always be present
    //   data.views = parseCount(await page.$eval(viewSelector, el => el.innerText));
    // } catch (viewError) {
    //   console.warn('Could not find TikTok view count element:', viewError.message);
    // }

  } catch (err) {
    console.error('Error scraping TikTok metrics:', err.message);
    // Take screenshot on error
    try { await page.screenshot({ path: 'debug-tiktok-error.png' }); } catch (e) {}
  }
  return data;
}

// Add similar functions for Instagram, LinkedIn, Twitter if needed,
// focusing on waitForSelector before using $eval or evaluate.

async function extractGenericMetricsFromBodyText(page) {
    // Fallback only if platform-specific methods fail entirely
    console.warn('Using generic body text matching as a last resort.');
    const data = { likes: 0, comments: 0, shares: 0, views: 0 };
     try {
        const bodyText = await page.evaluate(() => document.body.innerText);
        // Generic patterns - adjust based on common platform keywords
        data.likes = parseCount(bodyText.match(/([\d.,]+[KMB]?)\s*(like|reaction|favorite)/i)?.[1]);
        data.comments = parseCount(bodyText.match(/([\d.,]+[KMB]?)\s*(comment|repl(?:y|ies))/i)?.[1]);
        data.shares = parseCount(bodyText.match(/([\d.,]+[KMB]?)\s*(share|retweet)/i)?.[1]);
        data.views = parseCount(bodyText.match(/([\d.,]+[KMB]?)\s+view/i)?.[1]);
     } catch (e) {
         console.error("Error during generic text match:", e.message);
     }
     return data;
}


// --- Main Scraper Function ---

async function scrapeEngagement(postUrl) {
  console.log(`Starting scrape for URL: ${postUrl}`);
  let browser;
  let data = {
    platform: '',
    postUrl,
    likes: 0,
    comments: 0,
    shares: 0,
    views: 0,
    scrapedAt: new Date().toISOString()
  };

  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome-stable',
      headless: true, // Use true for production, false for debugging
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu', // Often needed in headless Linux environments
        '--disable-features=IsolateOrigins',
        '--disable-site-isolation-trials',
        // '--disable-web-security', // Use with caution, can have security implications
        '--disable-features=AudioServiceOutOfProcess',
        '--window-size=1920,1080'
      ],
      ignoreHTTPSErrors: true
    });
    console.log('Browser launched successfully');

    const page = await browser.newPage();

    await page.setUserAgent(getRandomUserAgent());
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      // 'Referer': 'https://www.google.com/' // Sometimes useful, sometimes not
    });
    await page.setViewport({ width: 1920, height: 1080 });

    // Increase timeouts
    await page.setDefaultNavigationTimeout(90000); // 90 seconds
    await page.setDefaultTimeout(60000); // 60 seconds for other operations like waitForSelector

    console.log(`Navigating to: ${postUrl}`);
    try {
      await page.goto(postUrl, {
        waitUntil: 'networkidle2', // Wait for network activity to quiet down
        timeout: 80000 // Slightly less than default navigation timeout
      });
      console.log('Initial navigation successful.');
    } catch (navError) {
      console.warn(`Navigation error (${navError.message}). Trying to continue...`);
      // Check if page has *some* content despite error
      const pageTitle = await page.title();
      if (!pageTitle) {
        console.error("Page title is empty after navigation error, likely a fatal issue.");
        await page.screenshot({ path: 'debug-fatal-nav-error.png' });
        throw new Error(`Fatal navigation error: ${navError.message}`);
      }
      console.log(`Page title after error: ${pageTitle}`);
    }

    // Give page a bit more time to settle JS execution
    await delay(5000); // **REPLACED** page.waitForTimeout

    console.log('Page loaded. Current URL:', page.url());
    console.log('Page title:', await page.title());

    // Take screenshot *before* trying to interact (useful for debugging)
    try {
      await page.screenshot({ path: 'debug-screenshot-before-consent.png', fullPage: false });
      console.log('Screenshot before consent saved.');
    } catch (ssError) {
      console.warn('Could not save pre-consent screenshot:', ssError.message);
    }

    // --- Handle Cookie Consent ---
    // Use XPath which is better for finding text content
    const consentButtonXpaths = [
        '//button[contains(text(), "Accept all")]',
        '//button[contains(text(), "Accept All")]',
        '//button[contains(text(), "Allow all")]',
        '//button[contains(text(), "Allow All")]',
        '//button[contains(text(), "I accept")]',
        '//button[contains(text(), "I Accept")]',
        '//button[contains(text(), "Agree")]',
        '//button[contains(text(), "OK")]',
        '//button[contains(@data-cookiebanner, "accept")]', // Keep attribute selectors too
        '//button[contains(@data-testid, "accept")]',
        '//button[@title="Accept All"]', // Exact title matches
        '//button[@title="Accept all"]',
        '//div[@role="dialog"]//button[contains(., "Accept")]', // More specific if in a dialog
        '//div[contains(@class, "cookie")]//button[contains(., "Accept")]', // Common class names
    ];

    let consentClicked = false;
    for (const xpath of consentButtonXpaths) {
        try {
            const buttons = await page.$x(xpath); // Use $x for XPath
            if (buttons.length > 0) {
                console.log(`Found consent button with XPath: ${xpath}`);
                await buttons[0].click();
                console.log('Clicked consent button.');
                consentClicked = true;
                await delay(2000); // Wait for overlay to disappear **REPLACED** page.waitForTimeout
                break; // Exit loop once clicked
            }
        } catch (clickError) {
            console.warn(`Could not click consent button (${xpath}): ${clickError.message}`);
            // Button might have disappeared after finding it, continue searching
        }
    }

    if (!consentClicked) {
        console.warn('Could not find or click any known consent buttons.');
         // Take another screenshot if consent was potentially missed
         try {
            await page.screenshot({ path: 'debug-screenshot-no-consent-click.png', fullPage: false });
            console.log('Screenshot after failed consent attempt saved.');
         } catch (ssError) {
            console.warn('Could not save no-consent screenshot:', ssError.message);
         }
    } else {
         // Screenshot after successful click
         try {
            await page.screenshot({ path: 'debug-screenshot-after-consent.png', fullPage: false });
            console.log('Screenshot after consent click saved.');
         } catch (ssError) {
            console.warn('Could not save post-consent screenshot:', ssError.message);
         }
    }


    // --- Extract Metrics Based on Platform ---
    let metrics;
    const currentUrl = page.url(); // Use the final URL after potential redirects

    if (currentUrl.includes('facebook.com') || postUrl.includes('facebook.com')) { // Check original too
        data.platform = 'Facebook';
        metrics = await extractFacebookMetrics(page);
    } else if (currentUrl.includes('tiktok.com')) {
        data.platform = 'TikTok';
        metrics = await extractTikTokMetrics(page);
    }
    // Add else if blocks for instagram, linkedin, twitter, x.com
    // else if (currentUrl.includes('instagram.com')) { ... }
    // else if (currentUrl.includes('linkedin.com')) { ... }
    // else if (currentUrl.includes('twitter.com') || currentUrl.includes('x.com')) { ... }
    else {
        console.warn(`Platform not explicitly recognized for URL: ${currentUrl}. Trying generic text match.`);
        // Attempt a generic fallback if platform is unknown or specific extraction failed
        metrics = await extractGenericMetricsFromBodyText(page);
    }

    // If platform-specific extraction failed, maybe try the generic one
    if (metrics && metrics.likes === 0 && metrics.comments === 0 && metrics.shares === 0 && metrics.views === 0) {
        console.warn(`Platform-specific extraction for ${data.platform} yielded no results. Trying generic.`);
        const genericMetrics = await extractGenericMetricsFromBodyText(page);
        // Merge results, prioritizing non-zero generic results only if specific ones were zero
        metrics.likes = metrics.likes || genericMetrics.likes;
        metrics.comments = metrics.comments || genericMetrics.comments;
        metrics.shares = metrics.shares || genericMetrics.shares;
        metrics.views = metrics.views || genericMetrics.views;
    }


    // Update the main data object
    if (metrics) {
        data = { ...data, ...metrics };
    }

    console.log(`Scraped data: ${JSON.stringify(data)}`);
    return data;

  } catch (err) {
    console.error(`[SCRAPE ERROR] for ${postUrl}:`, err); // Log the full error
    // Optionally take a screenshot on major errors
    if (browser && !browser.isConnected()) {
         console.error("Browser crashed or disconnected.");
    } else if (browser) {
        try {
            const page = (await browser.pages())[0]; // Get the page if possible
            if(page) await page.screenshot({ path: 'debug-scrape-error.png' });
        } catch (ssError) {
            console.error("Could not take error screenshot:", ssError);
        }
    }
    // Return null or the partially filled data object to indicate failure
    return { ...data, error: err.message }; // Include error message in returned data

  } finally {
    if (browser) {
      console.log('Closing browser');
      await browser.close();
    }
  }
}

// --- Database Interaction ---

async function insertEngagement(pool, data) {
    // Ensure data fields are numbers and handle potential nulls/NaNs
    const likes = Number(data.likes) || 0;
    const comments = Number(data.comments) || 0;
    const shares = Number(data.shares) || 0;
    const views = Number(data.views) || 0;
    const platform = data.platform || 'Unknown'; // Default platform if empty
    const postUrl = data.postUrl;
    const scrapedAt = data.scrapedAt ? new Date(data.scrapedAt) : new Date(); // Ensure valid date


  // Check if essential data is present
  if (!postUrl) {
      console.error('[SQL ERROR] Cannot insert data without postUrl.');
      throw new Error('Missing postUrl for database insertion.');
  }

  try {
    console.log(`Inserting data to database for ${postUrl}: L:${likes}, C:${comments}, S:${shares}, V:${views}`);
    await pool.request()
      .input('Platform', sql.NVarChar, platform)
      .input('PostUrl', sql.NVarChar, postUrl)
      .input('Likes', sql.Int, likes)
      .input('Comments', sql.Int, comments)
      .input('Shares', sql.Int, shares)
      .input('Views', sql.Int, views)
      .input('ScrapedAt', sql.DateTime, scrapedAt)
      // Add CampaignId input if it exists in data and your table has the column
      // .input('CampaignId', sql.Int, data.campaignId || null) // Example
      .query(`
        INSERT INTO SocialMediaEngagement (Platform, PostUrl, Likes, Comments, Shares, Views, ScrapedAt /*, CampaignId */)
        VALUES (@Platform, @PostUrl, @Likes, @Comments, @Shares, @Views, @ScrapedAt /*, @CampaignId */)
      `); // Add CampaignId to query if needed
    console.log('Data inserted successfully');
  } catch (err) {
    console.error(`[SQL ERROR] Failed to insert data for ${postUrl}: ${err.message}`);
    // Log the data that failed to insert for debugging
    console.error('Failed data:', JSON.stringify({ platform, postUrl, likes, comments, shares, views, scrapedAt }));
    throw err; // Re-throw to be caught by the route handler
  }
}

// --- API Routes ---

router.post('/engagement', upload.none(), async (req, res) => {
  console.log('================= NEW REQUEST =================');
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const { postUrl, campaignId } = req.body; // Assuming campaignId might be needed later

  if (!postUrl) {
    console.log('Missing postUrl in request');
    return res.status(400).json({ error: 'postUrl is required' });
  }

  // Basic URL validation (optional but recommended)
  try {
      new URL(postUrl);
  } catch (_) {
      console.log('Invalid postUrl format:', postUrl);
      return res.status(400).json({ error: 'Invalid postUrl format' });
  }


  const pool = req.app.locals.db;
  if (!pool) {
    console.log('Database connection not available');
    return res.status(500).json({ error: 'Database connection not available' });
  }

  try {
    console.log(`Processing engagement request for URL: ${postUrl}`);
    const scrapedData = await scrapeEngagement(postUrl);

    if (!scrapedData || scrapedData.error) {
      console.log('Scraping failed or returned an error:', scrapedData?.error || 'Unknown scraping error');
      // Decide if you want to insert partial data or fail completely
      // Option 1: Fail completely
      return res.status(500).json({ error: 'Scraping failed', details: scrapedData?.error || 'Unknown error' });
      // Option 2: Try inserting whatever was gathered (handle potential errors in insertEngagement)
      // if (scrapedData) {
      //    try {
      //        const dataToInsert = { ...scrapedData, campaignId }; // Add campaignId if needed
      //        await insertEngagement(pool, dataToInsert);
      //        console.log('Inserted partial data after scraping error.');
      //        res.status(206).json(scrapedData); // 206 Partial Content maybe?
      //    } catch (dbError) {
      //        console.error('Failed to insert partial data after scrape error:', dbError);
      //        res.status(500).json({ error: 'Scraping failed and DB insert failed', details: dbError.message });
      //    }
      // } else {
      //    res.status(500).json({ error: 'Scraping failed critically' });
      // }
      // return;
    }

    // Add campaignId to data if provided, before inserting
    const dataToInsert = { ...scrapedData, campaignId }; // Make sure your DB function handles campaignId if needed

    await insertEngagement(pool, dataToInsert);

    console.log('Successfully scraped and inserted data. Returning to client.');
    res.status(200).json(scrapedData); // Return the scraped data

  } catch (err) {
    console.error('[POST /engagement ROUTE ERROR]', err.message);
    res.status(500).json({ error: 'Internal server error processing engagement', details: err.message });
  }
});

// GET route remains mostly the same for testing
router.get('/test-scraper', async (req, res) => {
  const testUrl = req.query.url || 'https://www.facebook.com/share/v/1WDsDXD3nk/'; // Use the problematic URL as default test

  try {
    console.log(`Testing scraper with URL: ${testUrl}`);
    const data = await scrapeEngagement(testUrl);

    if (!data || data.error) {
        console.error('Scraper test failed:', data?.error || 'Unknown error');
      return res.status(500).json({
          success: false,
          error: 'Scraper test failed',
          details: data?.error || 'Unknown error',
          scrapedData: data // Return partial data if available
        });
    }

    res.json({
      success: true,
      message: 'Scraper test completed.',
      data
    });
  } catch (err) {
    console.error('[TEST SCRAPER ERROR]', err.message);
    res.status(500).json({
      success: false,
      error: 'Scraper test failed with exception',
      details: err.message
    });
  }
});

module.exports = router;