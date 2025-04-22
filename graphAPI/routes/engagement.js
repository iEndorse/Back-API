// ****** Keep all require statements and helper functions from your original code ******
require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-core'); // Still using core here
const sql = require('mssql'); // Keep if inserting data
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

const upload = multer();
const router = express.Router();

// --- Constants ---
const COOKIE_FILE_PATH = path.join(__dirname, 'cookies.json'); // Path to load cookies from
const SCREENSHOT_DIR = path.join(__dirname, 'debug_screenshots');

// --- Helper Functions ---
function delay(ms) { /* ... */ }
// function parseCount(text) { /* Keep if extracting metrics */ }
function getRandomUserAgent() { /* ... */ }

// --- Platform Specific Extraction Logic ---
// KEEP your desired version of extractFacebookMetrics (e.g., v6 or the screenshot-only one)
// For this example, I'll assume you want the screenshot-only logic from the previous step.
// If you want metric extraction, paste your preferred extractFacebookMetrics version here.

// --- Screenshot Only Function (Example - Replace if you need metrics) ---
async function takeScreenshotOnly(page, postUrl) {
    console.log(`Attempting screenshot for: ${postUrl}`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotFile = path.join(SCREENSHOT_DIR, `fb_post_${timestamp}.png`);
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true }); // Ensure dir exists

    try {
        // Add a delay *after* navigation (which happens in scrapeEngagement)
        console.log('Waiting after navigation for rendering...');
        await delay(5000); // Adjust delay as needed

        console.log(`Attempting to save screenshot to: ${screenshotFile}`);
        await page.screenshot({
            path: screenshotFile,
            fullPage: true
        });
        console.log(`Screenshot saved successfully!`);
        return { success: true, screenshotFile };

    } catch (err) {
        console.error(`Error taking screenshot for ${postUrl}:`, err);
        return { success: false, screenshotFile: null, error: err.message };
    }
}


// --- Main Scraper Function (Modified for Cookie Loading) ---
async function scrapeEngagement(postUrl) {
  console.log(`Starting scrape using COOKIES for URL: ${postUrl}`);
  let browser = null;
  // Data structure depends on whether you extract metrics or just screenshot
  let resultData = {
      success: false, // Default to failure
      screenshotFile: null,
      error: null,
      // Add metrics fields back if using extractFacebookMetrics
      // platform: '', postUrl, likes: 0, comments: 0, shares: 0, views: 0, scrapedAt: new Date().toISOString()
  };

  try {
    // **** Check/Set executablePath ****
    const chromeExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable'; // CHANGE IF NEEDED
    try { await fs.access(chromeExecutablePath); console.log(`Using executable path: ${chromeExecutablePath}`);
    } catch { console.error(`!!! Chrome executable not found at: ${chromeExecutablePath} !!!`); throw new Error(`Chrome executable not found: ${chromeExecutablePath}`); }

    browser = await puppeteer.launch({
      executablePath: chromeExecutablePath,
      headless: true, // Headless should work fine with cookies
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-features=IsolateOrigins','--disable-site-isolation-trials','--disable-features=AudioServiceOutOfProcess','--window-size=1280,1024', '--log-level=0', '--mute-audio' ],
      ignoreHTTPSErrors: true
    });
    console.log('Browser launched successfully');
    const page = await browser.newPage();

    await page.setUserAgent(getRandomUserAgent());
    await page.setExtraHTTPHeaders({'Accept-Language': 'en-US,en;q=0.9'});
    await page.setViewport({ width: 1280, height: 1024 });
    await page.setDefaultNavigationTimeout(60000);
    await page.setDefaultTimeout(45000);

    // ***** LOAD COOKIES *****
    console.log(`Attempting to load cookies from: ${COOKIE_FILE_PATH}`);
    try {
        const cookiesString = await fs.readFile(COOKIE_FILE_PATH);
        const cookies = JSON.parse(cookiesString);
        if (cookies && cookies.length) {
            await page.setCookie(...cookies);
            console.log(`Loaded ${cookies.length} cookies into browser session.`);
        } else {
             throw new Error('Cookie file is empty or invalid.'); // Treat empty as error
        }
    } catch (error) {
         console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
         if (error.code === 'ENOENT') {
             console.error(`ERROR: Cookie file not found: ${COOKIE_FILE_PATH}`);
             console.error(`       Please run the 'manual-login.js' script first to generate cookies.`);
         } else {
             console.error(`ERROR loading cookies: ${error.message}`);
             console.error(`       Consider deleting the cookies.json file and re-running 'manual-login.js'.`);
         }
          console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
         // Optionally try deleting the bad cookie file here
         // try { await fs.unlink(COOKIE_FILE_PATH); console.log("Deleted potentially corrupt cookie file."); } catch {}
         throw new Error(`Failed to load session cookies. Run manual-login.js first.`); // Stop execution
    }

    // --- Navigate to Target Post URL ---
    console.log(`Navigating to target post: ${postUrl}`);
    try {
      await page.goto(postUrl, { waitUntil: 'networkidle0', timeout: 55000 });
      console.log('Navigation to post successful.');
    } catch (navError) {
      console.warn(`Navigation to post finished with potential issues: ${navError.message}. Proceeding anyway...`);
      // Consider taking a screenshot here if nav fails
    }

    console.log('Target page loaded. Current URL:', page.url());

    // --- Perform Action (Screenshot or Metrics Extraction) ---
    // Choose ONE of the following based on your goal:

    // Option A: Screenshot Only
    const screenshotResult = await takeScreenshotOnly(page, postUrl);
    resultData = { ...resultData, ...screenshotResult }; // Combine results

    // Option B: Metrics Extraction (If you kept extractFacebookMetrics)
    /*
    if (page.url().includes('facebook.com')) {
        const metrics = await extractFacebookMetrics(page); // Use your preferred version
        resultData = {
             ...resultData, // Keep success/error/screenshot fields if needed
             platform: 'Facebook',
             postUrl: postUrl, // Use original postUrl
             likes: metrics?.likes || 0,
             comments: metrics?.comments || 0,
             shares: metrics?.shares || 0,
             views: metrics?.views || 0,
             scrapedAt: new Date().toISOString(),
             success: true // Assume success if metrics extracted, refine if needed
        };
    } else {
         // Handle non-facebook URLs if necessary
         resultData.error = "URL is not a Facebook URL";
         console.warn("URL is not a Facebook URL, skipping metric extraction.");
    }
    */


    // Ensure success flag is set if no error occurred during the primary action
    if (!resultData.error) {
         resultData.success = true;
    }


  } catch (err) {
     console.error(`[SCRAPE ENGAGEMENT FUNCTION ERROR] for ${postUrl}:`, err.stack);
     resultData.success = false;
     resultData.error = err.message || 'Unknown scraping error';
     /* Error Screenshot logic */
      if (browser && browser.isConnected()) { try { const pages = await browser.pages(); if (pages.length > 0) { await fs.mkdir(SCREENSHOT_DIR, { recursive: true }); const errScreenshotFile = path.join(SCREENSHOT_DIR, `debug-scrape-error-${new Date().toISOString().replace(/[:.]/g, '-')}.png`); await pages[pages.length-1].screenshot({ path: errScreenshotFile, fullPage: true }); console.log(`Saved error state screenshot to ${errScreenshotFile}`); } } catch (ssError) { console.error("Could not take error screenshot:", ssError); } } else { console.error("Browser likely crashed."); }

  } finally {
     if (browser) { console.log('Closing browser'); await browser.close(); }
  }

  // Return structure depends on whether you did screenshot or metrics
  console.log(`FINAL Result Data: ${JSON.stringify(resultData)}`);
  return resultData;

} // End of scrapeEngagement


// --- API Routes (Adjust based on whether you return metrics or just screenshot path) ---

router.post('/screenshot', upload.none(), async (req, res) => {
    console.log('\n================= NEW SCREENSHOT REQUEST (COOKIE LOGIN) =================');
    const { postUrl } = req.body;
    if (!postUrl) return res.status(400).json({ status: 'error', message: 'postUrl is required' });
    try { new URL(postUrl); } catch (_) { return res.status(400).json({ status: 'error', message: 'Invalid postUrl format' }); }

    try {
        console.log(`Processing screenshot request for URL: ${postUrl}`);
        const result = await scrapeEngagement(postUrl); // Calls the main function

        if (result.success && result.screenshotFile) { // Check specific fields for screenshot success
            console.log(`Successfully took screenshot for ${postUrl}.`);
            res.status(200).json({
                status: 'success',
                message: 'Screenshot taken successfully using cookies',
                url: postUrl,
                screenshotPath: result.screenshotFile // Provide path where it was saved on the server
            });
        } else {
            console.error(`Screenshot failed for ${postUrl}: ${result.error}`);
            res.status(500).json({ status: 'error', message: 'Screenshot failed', details: result.error, url: postUrl });
        }
    } catch (err) {
        console.error(`[POST /screenshot ROUTE ERROR] for ${postUrl}: ${err.message}`, err.stack);
        res.status(500).json({ status: 'error', message: 'Internal server error processing screenshot request', details: err.message, url: postUrl });
    } finally {
        console.log(`Finished processing screenshot request for ${postUrl}`); console.log('================= SCREENSHOT REQUEST END =================\n');
    }
});

router.get('/test-screenshot', async (req, res) => {
     const testUrl = req.query.url || 'https://www.facebook.com/share/p/16BKFREJ4m/';
     console.log('\n================= TEST SCREENSHOT REQUEST (COOKIE LOGIN) ================='); console.log(`Testing screenshot with URL: ${testUrl}`);
     try {
        const result = await scrapeEngagement(testUrl); // Calls the main function

        if (result.success && result.screenshotFile) {
             console.log(`Screenshot test successful for ${testUrl}.`);
             res.json({ success: true, message: 'Screenshot test completed successfully.', url: testUrl, screenshotPath: result.screenshotFile });
        } else {
             console.error('Screenshot test failed:', result.error);
             res.status(500).json({ success: false, message: 'Screenshot test failed', details: result.error, url: testUrl });
        }
     } catch (err) {
         console.error('[TEST SCREENSHOT ROUTE ERROR]', err.stack);
         res.status(500).json({ success: false, message: 'Screenshot test failed with an unexpected exception.', details: err.message, url: testUrl });
     } finally {
         console.log('================= TEST SCREENSHOT END =================\n');
     }
});


// --- Remove or keep Database/Metric routes/functions as needed ---
// async function insertEngagement(pool, data) { ... }
// router.post('/engagement', ...);
// router.get('/test-scraper', ...);

module.exports = router;