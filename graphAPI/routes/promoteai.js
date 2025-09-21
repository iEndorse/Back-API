const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sql = require('mssql');
const router = express.Router();
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require('openai');
const AWS = require('aws-sdk');

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg'); // adjust if needed
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Env variables
const pageId = process.env.PAGE_ID;
const TEMP_DIR = 'temp';
//const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// OpenAI setup
//const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// DynamoDB setup
AWS.config.update({
    region: 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = 'FacebookPosts';

async function createPost(postData) {
    await dynamoDB.put({ TableName: TABLE_NAME, Item: postData }).promise();
}

// Helper: Download file
async function downloadFileIfNeeded(filePath) {
    if (!filePath) throw new Error('File path undefined');
    const filename = `${uuidv4()}_${path.basename(filePath).replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const tempPath = path.join(TEMP_DIR, filename);

    if (filePath.startsWith('http')) {
        const resp = await axios({ method: 'get', url: filePath, responseType: 'stream' });
        await new Promise((res, rej) => {
            const ws = fs.createWriteStream(tempPath);
            resp.data.pipe(ws);
            ws.on('finish', res);
            ws.on('error', rej);
        });
    } else {
        if (!fs.existsSync(filePath)) throw new Error(`Local file not found: ${filePath}`);
        fs.copyFileSync(filePath, tempPath);
    }
    return tempPath;
}

// Convert image to PNG
async function convertImageToPng(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions(['-vf scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt rgb24'])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

// Create video from images
async function createVideoFromImages(imagePaths, outputVideoPath, duration = 40, audioPath = null) {
    return new Promise((resolve, reject) => {
        if (!imagePaths.length) return reject(new Error('No images provided'));
        const listFile = path.join(TEMP_DIR, `ffmpeg_list_${uuidv4()}.txt`);
        let listContent = '';
        const durationPerImage = duration / imagePaths.length;

        imagePaths.forEach((img, i) => {
            listContent += `file '${path.resolve(img).replace(/\\/g, '/')}'\n`;
            if (i < imagePaths.length - 1) listContent += `duration ${durationPerImage}\n`;
        });
        fs.writeFileSync(listFile, listContent);

        let cmd = ffmpeg()
            .input(listFile)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions([
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-vsync cfr',
                `-t ${duration}`,
                '-pix_fmt yuv420p',
                '-r 25',
                '-crf 0',
                '-preset slow'
            ]);

        if (audioPath && fs.existsSync(audioPath)) cmd = cmd.input(audioPath).outputOptions(['-shortest']);

        cmd.output(outputVideoPath)
            .on('end', () => { fs.unlinkSync(listFile); resolve(outputVideoPath); })
            .on('error', (err) => { fs.unlinkSync(listFile); reject(err); })
            .run();
    });
}

// Extract frames from video for AI analysis
async function extractFramesFromVideo(videoPath, frameDir) {
    if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .output(path.join(frameDir, 'frame_%04d.png'))
            .outputOptions(['-vf fps=1']) // 1 frame per second
            .on('end', () => {
                const files = fs.readdirSync(frameDir)
                    .filter(f => f.endsWith('.png'))
                    .map(f => path.join(frameDir, f));
                resolve(files);
            })
            .on('error', reject)
            .run();
    });
}

// Pick random audio
function getRandomAudio() {
    const audioDir = path.join(__dirname, '../uploads/audio');
    if (!fs.existsSync(audioDir)) return null;
    const files = fs.readdirSync(audioDir).filter(file => [".mp3", ".wav", ".m4a"].includes(path.extname(file).toLowerCase()));
    if (!files.length) return null;
    return path.join(audioDir, files[Math.floor(Math.random() * files.length)]);
}

// Safe unlink
function safeUnlink(file) { if (file && fs.existsSync(file)) fs.unlinkSync(file); }

// Parse AI response safely
function parseAIResponse(content) {
    try { return JSON.parse(content); } 
    catch { 
        return {
            format: 'static',
            rationale: 'Default format selected due to parsing error',
            content: { caption: content.substring(0, 200), hashtags: ['#IEndorseAI'] },
            summary: 'Content generated with default settings'
        };
    }
}

/**
 * Generates AI-powered social media comments for IEndorse campaigns
 * @param {Object} campaign - Campaign object containing title and description
 * @param {string} campaign.CampaignTitle - Title of the campaign
 * @param {string} campaign.CampaignDescription - Description of the campaign
 * @param {string} message - The post message to generate comments for
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<string[]>} Array of generated comments
 * @throws {Error} When OpenAI API fails or returns invalid response
 */
async function generateAIComments(campaign, message, apiKey) {
    // Validate input parameters
    if (!campaign || !campaign.CampaignTitle || !campaign.CampaignDescription) {
        throw new Error('Campaign object with CampaignTitle and CampaignDescription is required');
    }
    
    if (!message || typeof message !== 'string') {
        throw new Error('Post message is required and must be a string');
    }

    if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('OpenAI API key is required');
    }

    // Initialize OpenAI with the provided API key
    const openai = new OpenAI({
        apiKey: apiKey
    });

    const prompt = `
You are an AI social media engagement assistant for IEndorse.
Generate 5 short positive comments under 30 words each in JSON format:
{
  "comments": ["", "", "", "", ""]
}

Campaign Title: ${campaign.CampaignTitle}
Campaign Description: ${campaign.CampaignDescription}
Post Message: ${message}

Requirements:
- Each comment should be unique and relevant
- Use a professional, thought-leader tone
- Keep comments under 30 words
- Make comments engaging and authentic
- Avoid repetitive phrases`;
    
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { 
                    role: "system", 
                    content: "You are a professional social media engagement specialist. Generate authentic, varied comments that sound natural and engaging. Always respond with valid JSON format." 
                },
                { role: "user", content: prompt }
            ],
            max_tokens: 500,
            temperature: 0.8
        });

        // Validate response structure
        if (!response.choices || !response.choices[0] || !response.choices[0].message) {
            throw new Error('Invalid response structure from OpenAI API');
        }

        const content = response.choices[0].message.content;
        
        // Parse JSON response with error handling
        let parsedResponse;
        try {
            parsedResponse = JSON.parse(content);
        } catch (parseError) {
            console.error('Failed to parse OpenAI response as JSON:', content);
            throw new Error('OpenAI returned invalid JSON format');
        }

        // Validate parsed response structure
        if (!parsedResponse.comments || !Array.isArray(parsedResponse.comments)) {
            throw new Error('Response missing comments array');
        }

        // Filter out empty comments and ensure we have valid strings
        const validComments = parsedResponse.comments
            .filter(comment => comment && typeof comment === 'string' && comment.trim().length > 0)
            .map(comment => comment.trim());

        if (validComments.length === 0) {
            throw new Error('No valid comments generated');
        }

        return validComments;

    } catch (error) {
        // Enhanced error reporting
        if (error.response) {
            // OpenAI API error
            console.error('OpenAI API Error:', error.response.status, error.response.data);
            throw new Error(`OpenAI API error: ${error.response.status} - ${error.response.data?.error?.message || 'Unknown error'}`);
        } else if (error.message.includes('JSON')) {
            // JSON parsing error - already handled above
            throw error;
        } else {
            // Network or other errors
            console.error('Error generating AI comments:', error);
            throw new Error(`Failed to generate comments: ${error.message}`);
        }
    }
}

// OpenAI prompt for content
//const openAiPrompt = `...same as before...

//`; // use your existing prompt



const openAiPrompt = `
You are an advanced AI content engine for IEndorse, a platform that showcases brand campaigns on its social page. Your task is to analyze a brand's campaign input (text, images, and goals) and generate optimized content for IEndorse's feeds, prioritizing short-form videos (15-60 seconds) but selecting static images when they better suit the campaign's intent or audience. 

IMPORTANT: Your response MUST be valid JSON format. Follow this exact structure:

{
  "format": "video" or "static",
  "rationale": "Brief explanation for format choice",
  "content": {
    "caption": "Engaging caption text in the form curiosity question",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3"],
    "duration": 30 (for videos only)
  },
  "summary": "Brief summary of recommendations and predicted metrics"
}

Follow these steps:

1. Analyze Input:
   - Extract key elements from the campaign: product/service, target audience (e.g., Gen Z, professionals), goals (e.g., brand awareness, conversions), tone (e.g., bold, professional), and any provided images/text.

2. Choose Optimal Format:
   - Default to video (15-60 seconds) for consumer-focused campaigns, brand awareness, or younger audiences, as videos drive 59% higher engagement.
   - Select static images for campaigns with minimalist aesthetics, text-heavy messages, luxury branding, or B2B audiences.

3. Generate Content:
   - For Videos: Create engaging captions with call-to-action and trending hashtags.
   - For Static Posts: Enhance with compelling captions and relevant hashtags.
  

4. Optimize for Engagement:
   - Incorporate trending hashtags and keywords.
   - Provide predictive analytics in the summary.

Constraints:
• Ensure compliance with Meta's policies
• Keep videos short (15-60 seconds) and static posts visually striking
• Maintain brand alignment
• Always respond with valid JSON format
`;





const upload = multer();

router.post('/promote-campaign', upload.none(), async (req, res) => {
    const campaignId = Number(req.body.campaignId || req.query.campaignId);
    const accessToken = req.accessToken || req.body.accessToken || req.query.accessToken;
    const numberOfUnits = req.body.numberOfUnits || req.query.numberOfUnits;
    const endorsementNote = req.body.endorsementNote || req.query.endorsementNote;
    if (!campaignId || !pageId || !accessToken) return res.status(400).json({ error: 'Missing required parameters' });

    const tempFiles = [];
    let finalMediaPath = null;
    let isVideo = false;
    let aiContent = null;

    

    try {
        const pool = req.app.locals.db;


        
        const OPENAI_API_KEY = req.openai_api_key;
    console.log(OPENAI_API_KEY);
    
    // Initialize OpenAI correctly
    const openai = new OpenAI({
      apiKey: OPENAI_API_KEY
    });
    
        if (!pool) return res.status(500).json({ error: 'DB not connected' });

        // Get campaign info
        const campaignResult = await pool.request()
            .input('campaignId', sql.Int, campaignId)
            .query(`SELECT c.Id AS CampaignId, c.CampaignTitle, c.Description AS CampaignDescription,
                           c.CampaignUnit, c.CampaignLink,
                           cat.CategoryName AS CampaignCategory, a.FullName AS CampaignOwnerName,
                           a.EmailAddress AS CampaignOwnerEmail
                    FROM Campaigns c
                    INNER JOIN Categories cat ON c.CategoryId = cat.Id
                    INNER JOIN Accounts a ON c.AccountId = a.Id
                    WHERE c.Id=@campaignId`);
        if (!campaignResult.recordset.length) return res.status(404).json({ error: 'Campaign not found' });
        const campaign = campaignResult.recordset[0];

        // Get campaign files
        const filesResult = await pool.request()
            .input('campaignId', sql.Int, campaignId)
            .query('SELECT FilePath, FileType FROM CampaignFiles WHERE CampaignId=@campaignId');
        if (!filesResult.recordset.length) return res.status(400).json({ error: 'No campaign files' });

        const downloadedPaths = [];
        const types = [];
        for (const file of filesResult.recordset) {
            const tmp = await downloadFileIfNeeded(file.FilePath);
            tempFiles.push(tmp);
            downloadedPaths.push(tmp);
            types.push(file.FileType.toLowerCase());
        }

        // AI input preparation
        const images = downloadedPaths.filter((_, i) => types[i].includes('image') || types[i].includes('jpg') || types[i].includes('jpeg') || types[i].includes('png'));
        const videos = downloadedPaths.filter((_, i) => types[i].includes('video') || types[i].includes('mp4') || types[i].includes('mov'));

        // If video exists, extract frames
        if (videos.length > 0) {
            const frameDir = path.join(TEMP_DIR, `frames_${uuidv4()}`);
            const framePaths = await extractFramesFromVideo(videos[0], frameDir);
            tempFiles.push(...framePaths);
            images.push(...framePaths); // add frames to AI input
        }

        const aiInput = {
            text: `${campaign.CampaignTitle}\n${campaign.CampaignDescription}\n${endorsementNote || ''}`,
            images,
            goal: campaign.CampaignCategory.includes('B2B') ? 'conversions' : 'brand awareness',
            audience: campaign.CampaignCategory.includes('Fitness') ? 'Gen Z' : 'general',
            tone: campaign.CampaignCategory.includes('Luxury') ? 'professional' : 'energetic'
        };

        // Generate AI content
        const aiResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: openAiPrompt },
                { role: 'user', content: JSON.stringify(aiInput) }
            ],
            max_tokens: 1000
        });

        aiContent = parseAIResponse(aiResponse.choices[0].message.content);
       const { format, content } = aiContent;
       //  format === 'video'
        // Media processing
      
          // Identify images
              //  const images = downloadedPaths.filter((_,i)=> types[i].includes('image')||types[i].includes('jpg')||types[i].includes('jpeg')||types[i].includes('png'));
               if (videos.length>0 ){
                    finalMediaPath = downloadedPaths[0];
                    isVideo = true;
                } else  
              
              if(images.length>1){
                    const convertedPaths = [];
                    for(let i=0;i<images.length;i++){
                        const pngPath = path.join(TEMP_DIR, `conv_${i}_${uuidv4()}.png`);
                        await convertImageToPng(images[i], pngPath);
                        tempFiles.push(pngPath);
                        convertedPaths.push(pngPath);
                    
                    }
                    // Select random audio
                    const audioPath = getRandomAudio();
                    finalMediaPath = path.join(TEMP_DIR, `campaign_${campaignId}_${uuidv4()}.mp4`);
                    tempFiles.push(finalMediaPath);
                    const duration = 50; // total duration
                    await createVideoFromImages(convertedPaths, finalMediaPath, duration, audioPath);
                    isVideo = true;

                } 
               
                else {
                    finalMediaPath = downloadedPaths[0];
                    isVideo = false;
                }
        

        // Upload to Facebook
        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('source', fs.createReadStream(finalMediaPath));
         const message = `${content.caption }\nLink: ${campaign.CampaignLink}\n${content.hashtags?.join(' ') || ''}`;
       
         if (isVideo) {
                formData.append('description', message); // Not 'message' for video
            } else {
                formData.append('message', message); // 'message' works for photos
            }
      //   formData.append('description', message);
     //   const message = `${campaign.CampaignTitle}\n${campaign.CampaignDescription}\n${endorsementNote || ''}\nLink: ${campaign.CampaignLink}`;
     //   formData.append('description', message);

        
 
        const fbUrl = `https://graph-video.facebook.com/v19.0/${pageId}/${isVideo?'videos':'photos'}`;

       // const fbUrl = isVideo
       //     ? `https://graph-video.facebook.com/v19.0/${pageId}/videos`
        //    : `https://graph.facebook.com/v19.0/${pageId}/photos`;

        const fbResp = await axios.post(fbUrl, formData, { headers: formData.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });

        // Generate AI comments
        const aiComments = await generateAIComments(campaign, message, OPENAI_API_KEY);
        for (let comment of aiComments) {
            try {
                await axios.post(`https://graph.facebook.com/v19.0/${fbResp.data.id}/comments`,
                    { message: comment },
                    { params: { access_token: accessToken } }
                );
            } catch (cErr) { console.error("Error adding comment:", cErr.response?.data || cErr.message); }
        }

        // Post to Instagram








const IG_USER_ID= process.env.IG_USER_ID; // put your page token in .env

/**
 * Post media to Instagram (image or reel)
 * @param {string} mediaUrl - URL of the image or video
 * @param {string} caption - Caption text
 */

 caption = message;


  //console.log('finalMediaPath:', filesResult[0]);
  //console.log('finalMediaPath:', filesResult[0].FilePath);
 mediaUrl = filesResult.recordset[0].FilePath;
 console.log('mediaUrl:', mediaUrl);
 console.log('caption:', caption);

  try {
    let mediaType;

    if (mediaUrl.endsWith(".mp4")) {
      mediaType = "REELS"; // Instagram only supports reels for video
    } else {
      mediaType = "IMAGE";
    }

    // STEP 1: Create media container
    const containerRes = await axios.post(
      `https://graph.facebook.com/v21.0/${IG_USER_ID}/media`,
      null,
      {
        params: {
          access_token: accessToken,
          caption: caption, // IG might ignore this for reels, we'll update later
          ...(mediaType === "IMAGE"
            ? { image_url: mediaUrl }
            : { media_type: "REELS", video_url: mediaUrl }),
        },
      }
    );

    const creationId = containerRes.data.id;

     
 // Add a wait for Reels to avoid 'media not ready' error
if (mediaType === "REELS") {
  console.log("⏳ Waiting 30s for Reel to be ready...");
  await new Promise((r) => setTimeout(r, 30000));
}
  
  console.log("✅ Media ready to publish");

    console.log("✅ Media container created:", creationId);

    // STEP 2: Publish the media
    const publishRes = await axios.post(
      `https://graph.facebook.com/v21.0/${IG_USER_ID}/media_publish`,
      null,
      {
        params: {
          access_token: accessToken,
          creation_id: creationId,
        },
      }
    );

    const mediaId = publishRes.data.id;
    console.log("🚀 Published to Instagram with ID:", mediaId);

    // STEP 3: Update caption (only needed for reels, but safe for images too)
    if (caption) {
      await axios.post(
        `https://graph.facebook.com/v21.0/${mediaId}`,
        null,
        {
          params: {
            access_token: accessToken,
            caption: caption,
            comment_enabled: true
          },
        }
      );
      console.log("✍️ Caption updated for:", mediaId);
    }

    return mediaId;
  } catch (err) {
    console.error("❌ Error posting to Instagram:", err.response?.data || err.message);
    throw err;
  }








      

 
    } catch (err) {
        console.error('Error processing endorsement:', err);
        /*
        if (campaignId && pageId) {
            try { await createPost({ pageId, timestamp: Date.now(), postId: uuidv4(), campaignId, status: 'failed', errorMessage: err.message }); } 
            catch (e) { console.error('Failed to log to DynamoDB:', e); }
        }

        */

        res.status(500).json({ error: 'Failed to process endorsement', details: err.message });
/*
               // Save post to DynamoDB
        const postData = {
            pageId,
            timestamp: Date.now(),
            postId: uuidv4(),
            mediaId: fbResp.data.id,
            type: isVideo ? 'video' : 'image',
            campaignId: campaign.CampaignId,
            campaignTitle: campaign.CampaignTitle,
            campaignDescription: campaign.CampaignDescription,
            endorsementNote: endorsementNote || '',
            numberOfUnits: numberOfUnits || 0,
            originalFilePaths: filesResult.recordset.map(f => f.FilePath),
            message,
            status: 'posted'
         //   aiSummary: aiContent.summary
        };
       await createPost(postData);

       */

     //   res.status(200).json({ success: true, id: fbResp.data.id, postType: isVideo ? 'video' : 'image', message, aiComments });

    } finally { tempFiles.forEach(f => safeUnlink(f)); }
    
});

module.exports = router;
