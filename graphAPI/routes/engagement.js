const express = require('express');
const puppeteer = require('puppeteer');
const sql = require('mssql');
const multer = require('multer');
const upload = multer(); // This stores in memory; for file uploads you can customize this


const router = express.Router();

// Parse K/M counts like "3.5K" or "1.2M"
function parseCount(text) {
  if (!text) return 0;
  const match = text.replace(/,/g, '').match(/^([\d.]+)([KM]?)$/i);
  if (!match) return parseInt(text);
  const num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  return Math.round(suffix === 'K' ? num * 1000 : suffix === 'M' ? num * 1000000 : num);
}

// Scraper
async function scrapeEngagement(postUrl) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  let data = {
    platform: '',
    postUrl,
    likes: 0,
    comments: 0,
    shares: 0,
    views: 0
  };

  try {
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    const bodyText = await page.evaluate(() => document.body.innerText);

    if (postUrl.includes('tiktok.com')) {
      data.platform = 'TikTok';
      await page.waitForSelector('[data-e2e="like-count"]');
      data.likes = parseCount(await page.$eval('[data-e2e="like-count"]', el => el.innerText));
      data.comments = parseCount(await page.$eval('[data-e2e="comment-count"]', el => el.innerText));
      data.shares = parseCount(await page.$eval('[data-e2e="share-count"]', el => el.innerText));
    } else if (postUrl.includes('facebook.com')) {
      data.platform = 'Facebook';
      data.likes = parseCount(bodyText.match(/([\d,.]+)\s+likes?/i)?.[1] || '0');
      data.comments = parseCount(bodyText.match(/([\d,.]+)\s+comments?/i)?.[1] || '0');
      data.shares = parseCount(bodyText.match(/([\d,.]+)\s+shares?/i)?.[1] || '0');
    } else if (postUrl.includes('instagram.com')) {
      data.platform = 'Instagram';
      data.likes = parseCount(bodyText.match(/([\d,.]+)\s+likes?/i)?.[1] || '0');
      data.comments = parseCount(bodyText.match(/([\d,.]+)\s+comments?/i)?.[1] || '0');
    } else if (postUrl.includes('linkedin.com')) {
      data.platform = 'LinkedIn';
      data.likes = parseCount(bodyText.match(/([\d,.]+)\s+reactions?/i)?.[1] || '0');
      data.comments = parseCount(bodyText.match(/([\d,.]+)\s+comments?/i)?.[1] || '0');
    } else if (postUrl.includes('twitter.com') || postUrl.includes('x.com')) {
      data.platform = 'Twitter';
      data.likes = parseCount(bodyText.match(/([\d,.]+)\s+likes?/i)?.[1] || '0');
      data.comments = parseCount(bodyText.match(/([\d,.]+)\s+replies?/i)?.[1] || '0');
      data.shares = parseCount(bodyText.match(/([\d,.]+)\s+retweets?/i)?.[1] || '0');
      data.views = parseCount(bodyText.match(/([\d,.]+)\s+views?/i)?.[1] || '0');
    }

    return data;

  } catch (err) {
    console.error('[SCRAPE ERROR]', err.message);
    return null;
  } finally {
    await browser.close();
  }
}

// Insert into DB using the shared connection pool
async function insertEngagement(pool, data) {
  try {
    await pool.request()
      .input('Platform', sql.NVarChar, data.platform)
      .input('PostUrl', sql.NVarChar, data.postUrl)
      .input('Likes', sql.Int, data.likes)
      .input('Comments', sql.Int, data.comments)
      .input('Shares', sql.Int, data.shares)
      .input('Views', sql.Int, data.views)
      .query(`
        INSERT INTO SocialMediaEngagement (Platform, PostUrl, Likes, Comments, Shares, Views)
        VALUES (@Platform, @PostUrl, @Likes, @Comments, @Shares, @Views)
      `);
  } catch (err) {
    console.error('[SQL ERROR]', err.message);
    throw err;
  }
}

// POST /engagement



    // POST endpoint to handle multipart/form-data
router.post('/engagement', upload.none(), async (req, res) => {
  const { postUrl, campaignId } = req.body;

    console.log('================= NEW REQUEST =================');
    console.log('Request body type:', typeof req.body);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Request headers:', req.headers);
    console.log('Request params:', req.params);
    console.log('Request query:', req.query);
    if (!postUrl) return res.status(400).json({ error: 'postUrl is required check' });
     
    if (!postUrl) return res.status(400).json({ error: 'postUrl is required' });
  
    const pool = req.app.locals.db;
    if (!pool) return res.status(500).json({ error: 'Database connection not available' });
  
    try {
      const data = await scrapeEngagement(postUrl);
      if (!data) return res.status(500).json({ error: 'Scraping failed' });
  
      await insertEngagement(pool, data);
      res.json(data);
    } catch (err) {
      console.error('[ENGAGEMENT ERROR]', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  

module.exports = router;
