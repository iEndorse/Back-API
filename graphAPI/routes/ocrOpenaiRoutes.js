const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const { OpenAI } = require('openai');
const sql = require('mssql');
require('dotenv').config();

const router = express.Router();

// --- Utility: Platform Extractor ---
function extractPlatformFromUrl(url) {
  if (!url) return 'Unknown';

  const lowerUrl = url.toLowerCase();

  if (lowerUrl.includes('facebook.com')) return 'Facebook';
  if (lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com')) return 'Twitter';
  if (lowerUrl.includes('instagram.com')) return 'Instagram';
  if (lowerUrl.includes('linkedin.com')) return 'LinkedIn';
  if (lowerUrl.includes('tiktok.com')) return 'TikTok';
  if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) return 'YouTube';
  if (lowerUrl.includes('pinterest.com')) return 'Pinterest';
  if (lowerUrl.includes('snapchat.com')) return 'Snapchat';
  if (lowerUrl.includes('reddit.com')) return 'Reddit';
  if (lowerUrl.includes('threads.net')) return 'Threads';
  if (lowerUrl.includes('tumblr.com')) return 'Tumblr';

  return 'Unknown';
}
// --- End of Platform Extractor ---

// Set up uploads directory
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({ dest: uploadsDir });

// POST route
router.post('/openaiImage', upload.single('image'), async (req, res) => {
  try {
    const OPENAI_API_KEY = req.openai_api_key;
    console.log(OPENAI_API_KEY);
    
    // Initialize OpenAI correctly
    const openai = new OpenAI({
      apiKey: OPENAI_API_KEY
    });
    
    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    const imagePath = req.file.path;
    const mimeType = req.file.mimetype || 'image/jpeg';
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
Extract the number of reactions (likes, love, haha, wow, etc.), comments, shares, views, and saves.
Return your response in this exact JSON format:
{ "platform": <text>, "reactions": <number>, "comments": <number>, "shares": <number>, "views": <number>, "saves": <number> }

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

    // Clean up uploaded image
    fs.unlinkSync(imagePath); 

    const reply = response.choices[0].message.content;

    // Parse JSON from reply - use better regex or consider JSON.parse with try/catch
    let scrapedData;
    try {
      // Extract JSON block from reply with better handling
      const jsonMatch = reply.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        scrapedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not extract valid JSON from OpenAI response');
      }
    } catch (jsonError) {
      console.error('Error parsing JSON from OpenAI response:', jsonError);
      console.log('Raw response:', reply);
      return res.status(500).json({ error: 'Failed to parse metrics from image analysis.' });
    }

    // Database part
    const pool = req.app.locals.db;
    if (!pool) {
      console.error('Database connection not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const campaignId = req.body.campaignId ? parseInt(req.body.campaignId) : null;
    const accountId = req.body.accountId ? parseInt(req.body.accountId) : null;
    const postUrl = req.body.postUrl;
    
    if (!postUrl) {
      return res.status(400).json({ error: 'Post URL is required' });
    }

    const dataToInsert = {
      ...scrapedData,
      platform: scrapedData.platform || extractPlatformFromUrl(postUrl),
      postUrl: postUrl,
      scrapedAt: new Date(),
      campaignId: campaignId,
      accountId: accountId,
    };

    await insertEngagement(pool, dataToInsert);

    console.log('Successfully scraped and inserted data. Returning to client.');
    res.status(200).json(dataToInsert);

  } catch (err) {
    console.error('Error:', err);
    // Make sure to clean up the file if it exists and we encounter an error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to process image with OpenAI: ' + err.message });
  }
});

// --- Database Interaction ---
async function insertEngagement(pool, data) {
  const likes = isNaN(Number(data.reactions)) ? 0 : Number(data.reactions);
  const comments = isNaN(Number(data.comments)) ? 0 : Number(data.comments);
  const shares = isNaN(Number(data.shares)) ? 0 : Number(data.shares);
  const views = isNaN(Number(data.views)) ? 0 : Number(data.views);
  const saves = isNaN(Number(data.saves)) ? 0 : Number(data.saves);
  const platform = data.platform || 'Unknown';
  const postUrl = data.postUrl;
  const scrapedAt = data.scrapedAt ? new Date(data.scrapedAt) : new Date();
  const campaignId = data.campaignId || null;
  const accountId = data.accountId || null;

  if (!postUrl) {
    console.error('[SQL ERROR] Cannot insert data without postUrl.');
    throw new Error('Missing postUrl for database insertion.');
  }

  try {
    console.log(`Inserting data to database for ${postUrl}: L:${likes}, C:${comments}, S:${shares}, V:${views}, Sa:${saves}`);
    const request = pool.request();
    request.input('Platform', sql.NVarChar, platform);
    request.input('PostUrl', sql.NVarChar, postUrl);
    request.input('Likes', sql.Int, likes);
    request.input('Comments', sql.Int, comments);
    request.input('Shares', sql.Int, shares);
    request.input('Views', sql.Int, views);
    request.input('Saves', sql.Int, saves);
    request.input('ScrapedAt', sql.DateTime, scrapedAt);
    
    // Only add campaign and account parameters if they exist
    if (campaignId !== null) {
      request.input('CampaignId', sql.Int, campaignId);
    }
    if (accountId !== null) {
      request.input('AccountId', sql.Int, accountId);
    }

    // Build the SQL query dynamically based on which fields are present
    const columns = ['Platform', 'PostUrl', 'Likes', 'Comments', 'Shares', 'Views', 'Saves', 'ScrapedAt'];
    const parameters = ['@Platform', '@PostUrl', '@Likes', '@Comments', '@Shares', '@Views', '@Saves', '@ScrapedAt'];
    
    if (campaignId !== null) {
      columns.push('CampaignId');
      parameters.push('@CampaignId');
    }
    
    if (accountId !== null) {
      columns.push('AccountId');
      parameters.push('@AccountId');
    }
    
    const query = `
      INSERT INTO SocialMediaEngagement (${columns.join(', ')})
      VALUES (${parameters.join(', ')})
    `;

    await request.query(query);
    console.log('Data inserted successfully');
  } catch (err) {
    console.error(`[SQL ERROR] Failed to insert data for ${postUrl}: ${err.message}`);
    console.error('Failed data:', JSON.stringify({ platform, postUrl, likes, comments, shares, views, saves, scrapedAt }));
    throw err;
  }
}
// --- End of Database Interaction ---

module.exports = router;