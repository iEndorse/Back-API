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

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg'); // Adjust if needed

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Env variables
const pageId = process.env.PAGE_ID;
const TEMP_DIR = 'temp';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Add to .env
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// OpenAI setup
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// DynamoDB setup
const AWS = require('aws-sdk');
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

// Helper: Download remote file if needed
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

// Helper: Convert image to PNG
async function convertImageToPng(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-pix_fmt rgb24'
            ])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

// Helper: Create video from images
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

        if (audioPath && fs.existsSync(audioPath)) {
            cmd = cmd.input(audioPath).outputOptions(['-shortest']);
        }

        cmd.output(outputVideoPath)
            .on('end', () => { fs.unlinkSync(listFile); resolve(outputVideoPath); })
            .on('error', (err) => { fs.unlinkSync(listFile); reject(err); })
            .run();
    });
}

// Helper: Pick random audio file
function getRandomAudio() {
    const audioDir = path.join(__dirname, '../uploads/audio');
    if (!fs.existsSync(audioDir)) return null;

    const files = fs.readdirSync(audioDir).filter(file =>
        [".mp3", ".wav", ".m4a"].includes(path.extname(file).toLowerCase())
    );

    if (!files.length) return null;

    const randomFile = files[Math.floor(Math.random() * files.length)];
    return path.join(audioDir, randomFile);
}

// Safe unlink
function safeUnlink(file) { if (file && fs.existsSync(file)) fs.unlinkSync(file); }

// Helper: Parse AI response safely
function parseAIResponse(content) {
    try {
        return JSON.parse(content);
    } catch (error) {
        // If JSON parsing fails, return a structured default response
        return {
            format: 'static',
            rationale: 'Default format selected due to parsing error',
            content: {
                caption: content.substring(0, 200), // Use first 200 chars as caption
                hashtags: ['#IEndorseAI']
            },
            summary: 'Content generated with default settings'
        };
    }
}

// OpenAI Prompt for IEndorse
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


// 🔹 New helper: generate AI comments
async function generateAIComments(campaign, message) {
    const prompt = `
You are an AI social media engagement assistant for IEndorse.
Given a campaign and its post content, generate 5 short, natural, positive comments to explain and endorse the campaign.
that real people might leave to support, endorse, or react to the post.

Each comment must be under 30 words, with thought leader tone.
Return them strictly in JSON format:

{
  "comments": ["Comment 1", "Comment 2", "Comment 3", "Comment 4", "Comment 5"]
}

Campaign Title: ${campaign.CampaignTitle}
Campaign Description: ${campaign.CampaignDescription}
Post Message: ${message}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: "You generate marketing comments to explain the campaign in stepwise manner with the aim of engaging the audience." },
                { role: "user", content: prompt }
            ],
            max_tokens: 400
        });

        const content = response.choices[0].message.content;
        const parsed = JSON.parse(content);
        return parsed.comments || [];
    } catch (err) {
        console.error("Error generating AI comments:", err.message);
        return [
            "Amazing initiative! 🚀",
            "This is exactly what we need 🙌",
            "Great work by the team!",
            "Proud to endorse this campaign 💙",
            "Looking forward to seeing the impact!"
        ];
    }
}

const upload = multer();

router.post('/promote-campaign1', upload.none(), async (req, res) => {
    const campaignId = Number(req.body.campaignId || req.query.campaignId);
    const accessToken = req.accessToken || req.body.accessToken || req.query.accessToken;
    const numberOfUnits = req.body.numberOfUnits || req.query.numberOfUnits;
    const endorsementNote = req.body.endorsementNote || req.query.endorsementNote;

    if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });
    if (!pageId) return res.status(400).json({ error: 'PAGE_ID missing' });
    if (!accessToken) return res.status(400).json({ error: 'Access token required' });
    if (!OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI API key missing' });

    const tempFiles = [];
    let finalMediaPath = null;
    let isVideo = false;
    let aiContent = null;

    try {
        const pool = req.app.locals.db;
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

        // Use OpenAI to generate optimized content
        const aiInput = {
            text: `${campaign.CampaignTitle}\n${campaign.CampaignDescription}\n${endorsementNote || ''}`,
            images: downloadedPaths.filter((_, i) => types[i].includes('image') || types[i].includes('jpg') || types[i].includes('jpeg') || types[i].includes('png')),
            goal: campaign.CampaignCategory.includes('B2B') ? 'conversions' : 'brand awareness', // Simplified logic
            audience: campaign.CampaignCategory.includes('Fitness') ? 'Gen Z' : 'general', // Adjust based on your data
            tone: campaign.CampaignCategory.includes('Luxury') ? 'professional' : 'energetic'
        };

        const aiResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: openAiPrompt },
                { role: 'user', content: JSON.stringify(aiInput) }
            ],
            max_tokens: 1000
        });

        aiContent = parseAIResponse(aiResponse.choices[0].message.content);
        const { format, rationale, content, summary } = aiContent;

        // Process media based on AI recommendation
        const images = downloadedPaths.filter((_, i) => types[i].includes('image') || types[i].includes('jpg') || types[i].includes('jpeg') || types[i].includes('png'));
        if (format === 'video' && images.length > 0) {
            const convertedPaths = [];
            for (let i = 0; i < images.length; i++) {
                const pngPath = path.join(TEMP_DIR, `conv_${i}_${uuidv4()}.png`);
                await convertImageToPng(images[i], pngPath);
                tempFiles.push(pngPath);
                convertedPaths.push(pngPath);
            }

            const audioPath = getRandomAudio();
            finalMediaPath = path.join(TEMP_DIR, `campaign_${campaignId}_${uuidv4()}.mp4`);
            tempFiles.push(finalMediaPath);
            const duration = content.duration || 50;
            await createVideoFromImages(convertedPaths, finalMediaPath, duration, audioPath);
            isVideo = true;
        } else if (downloadedPaths.length === 1 && types[0].includes('video')) {
            finalMediaPath = downloadedPaths[0];
            isVideo = true;
        } else {
            finalMediaPath = images[0] || downloadedPaths[0];
            isVideo = false;
        }



        /*
        formData.append('source', fs.createReadStream(finalMediaPath));
        const message = ⁠ ${content.caption || campaign.CampaignTitle}\n${campaign.CampaignDescription}\n${endorsementNote || ''}\nLink: ${campaign.CampaignLink}\nPowered by IEndorse AI\n${content.hashtags?.join(' ') || ''} ⁠;
        formData.append('description', message);


        */




        const formData = new FormData();
formData.append('access_token', accessToken);
formData.append('source', fs.createReadStream(finalMediaPath));
const message = `${campaign.CampaignTitle}\n${campaign.CampaignDescription}\n${endorsementNote || ''}\nLink: ${campaign.CampaignLink}`;
formData.append('description', message);

const fbUrl = `https://graph-video.facebook.com/v19.0/${pageId}/${isVideo ? 'videos' : 'photos'}`;



 try {
            const fbResp = await axios.post(fbUrl, formData, {
                headers: formData.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

/*
        // Post to Facebook
        const formData = new FormData();
        formData.append('source', fs.createReadStream(finalMediaPath));
        const message = `${content.caption }\nLink: ${campaign.CampaignLink}\n${content.hashtags?.join(' ') || ''}`;
        formData.append('description', message);
        const baseUrl = isVideo
            ? `https://graph-video.facebook.com/v19.0/${pageId}/videos`
            : `https://graph.facebook.com/v19.0/${pageId}/photos`;
        const fbUrl = `${baseUrl}?access_token=${accessToken}`;

        try {
            const fbResp = await axios.post(fbUrl, formData, {
                headers: formData.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });


 */

            // 🔹 Generate AI comments
            const aiComments = await generateAIComments(campaign, message);

            // 🔹 Post each AI comment under the new FB post
            for (let comment of aiComments) {
                try {
                    await axios.post(
                        `https://graph.facebook.com/v19.0/${fbResp.data.id}/comments`,
                        { message: comment },
                        { params: { access_token: accessToken } }
                    );
                } catch (cErr) {
                    console.error("Error adding comment:", cErr.response?.data || cErr.message);
                }
            }

            




            const postData = {
                pageId,
                timestamp: Date.now(),
                postId: uuidv4(),
                mediaId: fbResp.data.id,
                type: isVideo ? 'video' : 'image',
                campaignId: campaign.CampaignId,
                campaignTitle: campaign.CampaignTitle || '',
                campaignDescription: campaign.CampaignDescription || '',
                endorsementNote: endorsementNote || '',
                numberOfUnits: numberOfUnits || 0,
                originalFilePaths: filesResult.recordset.map(f => f.FilePath),
                message,
                status: 'posted',
                aiSummary: summary
            };
            await createPost(postData);

            res.status(200).json({ 
                success: true, 
                id: fbResp.data.id, 
                postType: isVideo ? 'video' : 'image', 
                message, 
                aiSummary: summary ,
                aiComments // include generated comments in response
            });
        } catch (fbError) {
            console.error('Facebook API Error:', fbError.response?.data || fbError.message);
            if (fbError.response?.data?.error?.code === 100 && fbError.response?.data?.error?.error_subcode === 33) {
                return res.status(400).json({ error: 'Unsupported Graph API request', details: fbError.response.data });
            }
            throw fbError;
        }

    } catch (err) {
        console.error('Error processing endorsement:', err);
        if (campaignId && pageId) {
            try {
                await createPost({
                    pageId,
                    timestamp: Date.now(),
                    postId: uuidv4(),
                    campaignId: Number(campaignId),
                    status: 'failed',
                    errorMessage: err.message
                });
            } catch (e) { console.error('Failed to log to DynamoDB:', e); }
        }
        res.status(500).json({ error: 'Failed to process endorsement', details: err.message });
    } finally {
        tempFiles.forEach(f => safeUnlink(f));
    }
});

module.exports = router;
