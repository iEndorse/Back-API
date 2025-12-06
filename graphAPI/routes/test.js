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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// OpenAI setup
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// DynamoDB setup
const AWS = require('aws-sdk');

if (!process.env.AWS_EXECUTION_ENV) {
    // Local dev ONLY
    AWS.config.update({
        region: 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
} else {
    // Lambda – rely on role/region
    AWS.config.update({
        region: process.env.AWS_REGION || 'us-east-1',
    });
}
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

// AI comments
async function generateAIComments(campaign, message) {
    const prompt = `
You are an AI social media engagement assistant for IEndorse.
Generate 5 short positive comments under 30 words in JSON format:
{
  "comments": ["", "", "", "", ""]
}
Campaign Title: ${campaign.CampaignTitle}
Campaign Description: ${campaign.CampaignDescription}
Post Message: ${message}`;
    
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: "Generate short marketing comments in a thought-leader tone." },
                { role: "user", content: prompt }
            ],
            max_tokens: 400
        });
        return JSON.parse(response.choices[0].message.content).comments || [];
    } catch {
        return [
            "Amazing initiative! 🚀",
            "This is exactly what we need 🙌",
            "Great work by the team!",
            "Proud to endorse this campaign 💙",
            "Looking forward to seeing the impact!"
        ];
    }
}

// OpenAI prompt for content
const openAiPrompt = `...same as before...`; // use your existing prompt

const upload = multer();

router.post('/promote-campaign1', upload.none(), async (req, res) => {
    const campaignId = Number(req.body.campaignId || req.query.campaignId);
    const accessToken = req.accessToken || req.body.accessToken || req.query.accessToken;
    const numberOfUnits = req.body.numberOfUnits || req.query.numberOfUnits;
    const endorsementNote = req.body.endorsementNote || req.query.endorsementNote;
    if (!campaignId || !pageId || !accessToken || !OPENAI_API_KEY) return res.status(400).json({ error: 'Missing required parameters' });

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

    //    aiContent = parseAIResponse(aiResponse.choices[0].message.content);
      //  const { format, content } = aiContent;
       //  format === 'video'
        // Media processing
      
          // Identify images
              //  const images = downloadedPaths.filter((_,i)=> types[i].includes('image')||types[i].includes('jpg')||types[i].includes('jpeg')||types[i].includes('png'));
                if(images.length>1){
                    const convertedPaths = [];
                    for(let i=0;i<images.length;i++){
                        const pngPath = path.join(TEMP_DIR, `conv_${i}_${uuidv4()}.png`);
                        await convertImageToPng(images[i], pngPath);
                        tempFiles.push(pngPath);
                        convertedPaths.push(pngPath);
                    
        
                    // Select random audio
                    const audioPath = getRandomAudio();
                    finalMediaPath = path.join(TEMP_DIR, `campaign_${campaignId}_${uuidv4()}.mp4`);
                    tempFiles.push(finalMediaPath);
                    const duration = 50; // total duration
                    await createVideoFromImages(convertedPaths, finalMediaPath, duration, audioPath);
                    isVideo = true;}
                } else if (downloadedPaths.length===1 && types[0].includes('video')){
                    finalMediaPath = downloadedPaths[0];
                    isVideo = true;
                } else {
                    finalMediaPath = downloadedPaths[0];
                    isVideo = false;
                }
        

        // Upload to Facebook
        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('source', fs.createReadStream(finalMediaPath));
        const message = `${campaign.CampaignTitle}\n${campaign.CampaignDescription}\n${endorsementNote || ''}\nLink: ${campaign.CampaignLink}`;
        formData.append('description', message);

        
 
        const fbUrl = `https://graph-video.facebook.com/v19.0/${pageId}/${isVideo?'videos':'photos'}`;

       // const fbUrl = isVideo
       //     ? `https://graph-video.facebook.com/v19.0/${pageId}/videos`
        //    : `https://graph.facebook.com/v19.0/${pageId}/photos`;

        const fbResp = await axios.post(fbUrl, formData, { headers: formData.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });

        // Generate AI comments
        const aiComments = await generateAIComments(campaign, message);
        for (let comment of aiComments) {
            try {
                await axios.post(`https://graph.facebook.com/v19.0/${fbResp.data.id}/comments`,
                    { message: comment },
                    { params: { access_token: accessToken } }
                );
            } catch (cErr) { console.error("Error adding comment:", cErr.response?.data || cErr.message); }
        }

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

        res.status(200).json({ success: true, id: fbResp.data.id, postType: isVideo ? 'video' : 'image', message, aiComments });

    } catch (err) {
        console.error('Error processing endorsement:', err);
        if (campaignId && pageId) {
            try { await createPost({ pageId, timestamp: Date.now(), postId: uuidv4(), campaignId, status: 'failed', errorMessage: err.message }); } 
            catch (e) { console.error('Failed to log to DynamoDB:', e); }
        }
        res.status(500).json({ error: 'Failed to process endorsement', details: err.message });
    } finally { tempFiles.forEach(f => safeUnlink(f)); }
});

module.exports = router;
