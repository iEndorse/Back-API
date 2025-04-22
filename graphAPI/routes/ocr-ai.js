const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { firefox } = require('playwright-firefox');
require('dotenv').config();

const router = express.Router();

// Set up uploads directory
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({ dest: uploadsDir });

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Facebook credentials from .env file
const FB_EMAIL = process.env.FB_EMAIL;
const FB_PASSWORD = process.env.FB_PASSWORD;


// Helper function to take screenshot with Playwright
// Helper function to take screenshot with Playwright
async function takeScreenshot(url) {
    let browser = null;
    
    try {
      console.log(`Launching Firefox browser...`);
      browser = await firefox.launch({ 
        headless: true,
      });
      
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }
      });
      const page = await context.newPage();
      
      // First navigate to Facebook login page
      console.log('Navigating to Facebook login page...');
      await page.goto('https://www.facebook.com/', { 
        waitUntil: 'networkidle',
        timeout: 30000 
      });
      
      // Check if we need to handle cookie consent dialog
      try {
        const cookieButton = await page.$('button[data-testid="cookie-policy-manage-dialog-accept-button"]');
        if (cookieButton) {
          console.log('Accepting cookies...');
          await cookieButton.click();
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        console.log('No cookie dialog found or unable to click it:', e.message);
      }
      
      // Fill login form
      console.log('Attempting to log in with provided credentials...');
      if (!FB_EMAIL || !FB_PASSWORD) {
        throw new Error('Facebook credentials not found in .env file');
      }
      
      // Fill email/phone field
      await page.fill('input[name="email"]', FB_EMAIL);
      
      // Fill password field
      await page.fill('input[name="pass"]', FB_PASSWORD);
      
      // Click login button
      await page.click('button[name="login"]');
      
      // Wait for navigation after login
      await page.waitForNavigation({ waitUntil: 'networkidle' });
      
      // Check for login errors
      const errorElement = await page.$('div[class*="error"]');
      if (errorElement) {
        const errorText = await errorElement.textContent();
        throw new Error(`Facebook login failed: ${errorText}`);
      }
      
      console.log('Login successful, navigating to requested URL:', url);
      
      // Now navigate to the requested URL
      await page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: 30000 
      });
      
      // Wait for content to load properly
      await page.waitForTimeout(3000);
      
      // Check for login popups and close them
      try {
        const closeButton = await page.$('div[aria-label="Close"] button');
        if (closeButton) {
          console.log('Closing login popup...');
          await closeButton.click();
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        console.log('No login popup found or unable to close it:', e.message);
      }
      

    
    // Generate a unique filename
    const screenshotPath = path.join(uploadsDir, `screenshot_${Date.now()}.png`);
    
    console.log(`Taking screenshot and saving to: ${screenshotPath}`);
    // Take screenshot
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved at: ${screenshotPath}`);
    
    // Take a screenshot of what's visible right now, regardless of popups
    const visibleScreenshotPath = path.join(uploadsDir, `visible_${Date.now()}.png`);
    await page.screenshot({ path: visibleScreenshotPath });
    console.log(`Visible content screenshot saved at: ${visibleScreenshotPath}`);
    
    return screenshotPath;
  } catch (error) {
    console.error('Screenshot error:', error);
    throw new Error(`Failed to take screenshot: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error('Error closing browser:', e));
    }
  }
}

// Original route for direct image upload
router.post('/openaiold', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const imagePath = req.file.path;
  const mimeType = req.file.mimetype || 'image/jpeg';
  
  try {
    const result = await processImageWithOpenAI(imagePath, mimeType);
    res.json({ result });
  } catch (err) {
    console.error('OpenAI Error:', err);
    res.status(500).json({ error: 'Failed to process image with OpenAI.' });
  }
});

// New route for URL-based screenshots
router.post('/openai', upload.none(), async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  try {
    console.log(`Received request to screenshot URL: ${url}`);
    // Take screenshot using Playwright
    const screenshotPath = await takeScreenshot(url);
    const mimeType = 'image/png';
    
    console.log(`Successfully captured screenshot, processing with OpenAI`);
    // Process the screenshot
    const result = await processImageWithOpenAI(screenshotPath, mimeType);
    
    // Return both the result and image path
    res.json({ 
      result: result.metrics,
      imagePath: path.basename(result.imagePath)
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Failed to process URL', message: err.message });
  }
});

// Shared function to process images with OpenAI
async function processImageWithOpenAI(imagePath, mimeType) {
  try {
    const imageBase64 = fs.readFileSync(imagePath, { encoding: 'base64' });
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that extracts social media post metrics from images.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are analyzing a screenshot of a social media post.
Extract the number of reactions (likes, love, haha, wow, etc.), comments, shares, and saves.
Return your response in this exact JSON format:
{ "reactions": <number>, "comments": <number>, "shares": <number>, "saves": <number> , "views": <number> , "plays": <number> }

If a value is not visible, write "unknown".`,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 150,
    });

    // Keep the image file for debugging
    // fs.unlinkSync(imagePath);

    const reply = response.choices[0].message.content;

    // Extract JSON block from reply
    const jsonMatch = reply.match(/\{[\s\S]*?\}/);
    
    // Return both the metrics and the image path
    return {
      metrics: jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: reply },
      imagePath: imagePath
    };
    
  } catch (error) {
    // Don't delete on error for debugging purposes
    // if (fs.existsSync(imagePath)) {
    //   fs.unlinkSync(imagePath);
    // }
    throw error;
  }
}

module.exports = router;