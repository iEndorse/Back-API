// manual-login.js
require('dotenv').config();
const puppeteer = require('puppeteer-core'); // ***** Using puppeteer-core *****
const fs = require('fs').promises;
const path = require('path');

const COOKIE_FILE_PATH = path.join(__dirname, 'cookies.json');
const SCREENSHOT_DIR = path.join(__dirname, 'debug_screenshots'); // For potential error screenshots

(async () => {
  console.log('--- Manual Facebook Cookie Generation ---');
  let browser = null;

  try {
    // --- Get Chrome Path (Using SAME logic as scrapeEngagement) ---
    const chromeExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable'; // CHANGE IF NEEDED - MUST MATCH scrapeEngagement
    try {
        await fs.access(chromeExecutablePath);
        console.log(`Using executable path: ${chromeExecutablePath}`);
    } catch {
        console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.error(`ERROR: Chrome executable not found at: ${chromeExecutablePath}`);
        console.error(`Please install Chrome/Chromium or set PUPPETEER_EXECUTABLE_PATH`);
        console.error(`       Ensure this path matches the one used in the main app.`);
        console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        throw new Error(`Chrome executable not found: ${chromeExecutablePath}`);
    }

    // --- Launch Browser (Using SAME options as scrapeEngagement, except headless) ---
    console.log('Launching browser for manual login...');
    browser = await puppeteer.launch({
        executablePath: chromeExecutablePath, // Use the verified path
        headless: false, // ***** MUST be false for manual login *****
        args: [ // Use the same relevant args as scrapeEngagement
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Keep this, often needed
            '--disable-gpu',           // Keep this for consistency
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials',
            '--disable-features=AudioServiceOutOfProcess',
            // Use a specific window size or start maximized for manual ease
            // '--window-size=1280,1024',
            '--start-maximized',
            '--log-level=0',
             '--disable-infobars' // Good for manual view
            // Remove --mute-audio if you need sound during manual login
        ],
        ignoreHTTPSErrors: true,
        defaultViewport: null // Allow default viewport when not headless maximized
     });
     console.log('Browser launched successfully.');

    const page = await browser.newPage();
    // Set User Agent (Optional but good practice for consistency)
    // You might want to copy the getRandomUserAgent function here or use a fixed one
    // await page.setUserAgent(getRandomUserAgent()); // Or use a known good UA string

    console.log('Navigating to Facebook login page...');
    await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('\n*******************************************');
    console.log('ACTION REQUIRED: Please log in manually in the browser window.');
    console.log('Wait until you are fully logged in and see your news feed.');
    console.log('This script will wait for 3 minutes (180 seconds)...');
    console.log('*******************************************\n');

    // --- Wait for Manual Login ---
    await delay(180 * 1000); // Use delay instead of waitForTimeout

    // --- Check if Login Seems Successful (Optional but helpful) ---
     const loggedInIndicatorSelector = 'a[aria-label="Home"]';
     try {
         await page.waitForSelector(loggedInIndicatorSelector, { timeout: 5000 });
         console.log('Login detected (Home button found).');
     } catch (e) {
         console.warn('Warning: Could not detect a clear logged-in state. Saving cookies anyway.');
         // Take screenshot if detection fails
         try { await fs.mkdir(SCREENSHOT_DIR, { recursive: true }); const checkFailFile = path.join(SCREENSHOT_DIR, `debug-manual-login-check-fail-${new Date().toISOString().replace(/[:.]/g, '-')}.png`); await page.screenshot({ path: checkFailFile, fullPage: true }); console.log(`Manual Login check failure screenshot saved.`); } catch (ssError) { console.error("Screenshot fail:", ssError.message); }
     }

    // --- Save Cookies ---
    console.log('Attempting to save cookies...');
    const cookies = await page.cookies();
    // Filter only necessary facebook cookies (optional)
    const facebookCookies = cookies.filter(cookie => cookie.domain.includes('facebook.com') && ['c_user', 'xs'].includes(cookie.name));

     if(facebookCookies.length >= 2) { // Check if we got the essential ones
         await fs.writeFile(COOKIE_FILE_PATH, JSON.stringify(cookies, null, 2)); // Save ALL cookies
         console.log(`Cookies saved successfully to: ${COOKIE_FILE_PATH}`);
     } else {
          console.error('Error: Did not find essential Facebook session cookies (c_user, xs). Login likely failed or incomplete.');
          console.error('Please ensure you are fully logged in before the timeout.');
          // Optionally save the cookies anyway for debugging
          await fs.writeFile(COOKIE_FILE_PATH + '.debug', JSON.stringify(cookies, null, 2));
          console.log(`Saved all cookies (for debugging) to: ${COOKIE_FILE_PATH + '.debug'}`);
     }


  } catch (error) {
    console.error('An error occurred during manual login process:', error);
    // Take screenshot on major error during launch/navigation
    if(page && !fs.existsSync(COOKIE_FILE_PATH)) { // Only if cookies weren't saved
        try { await fs.mkdir(SCREENSHOT_DIR, { recursive: true }); const errorFile = path.join(SCREENSHOT_DIR, `debug-manual-login-ERROR-${new Date().toISOString().replace(/[:.]/g, '-')}.png`); await page.screenshot({ path: errorFile, fullPage: true }); console.log(`Error screenshot saved.`); } catch (ssError) { console.error("Screenshot fail:", ssError.message); }
    }
  } finally {
    if (browser) {
      console.log('Closing browser.');
      await browser.close();
    }
    console.log('Manual login script finished.');
  }
})();

// Utility function for delays (needed within this script)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}