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

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg'); // adjust if needed

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Env variables
const pageId = process.env.PAGE_ID;
const TEMP_DIR = 'temp';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

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

// Helper: download remote file if needed
async function downloadFileIfNeeded(filePath) {
    if (!filePath) throw new Error('File path undefined');
    const filename = `${uuidv4()}_${path.basename(filePath).replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const tempPath = path.join(TEMP_DIR, filename);

    if (filePath.startsWith('http')) {
        const resp = await axios({ method:'get', url:filePath, responseType:'stream' });
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

// Helper: convert image to PNG
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

// Helper: create video from images
async function createVideoFromImages(imagePaths, outputVideoPath, duration=40, audioPath=null) {
    return new Promise((resolve, reject) => {
        if (!imagePaths.length) return reject(new Error('No images provided'));

        const listFile = path.join(TEMP_DIR, `ffmpeg_list_${uuidv4()}.txt`);
        let listContent = '';
        const durationPerImage = duration / imagePaths.length;

        imagePaths.forEach((img, i) => {
            listContent += `file '${path.resolve(img).replace(/\\/g,'/')}'\n`;
            if (i < imagePaths.length -1) listContent += `duration ${durationPerImage}\n`;
        });
        fs.writeFileSync(listFile, listContent);

        let cmd = ffmpeg()
            .input(listFile)
            .inputOptions(['-f concat','-safe 0'])
            .outputOptions([
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-vsync cfr',
                `-t ${duration}`,
                '-pix_fmt yuv420p',
                `-r 25`,
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

// Helper: pick random audio file
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
function safeUnlink(file) { if(file && fs.existsSync(file)) fs.unlinkSync(file); }

const upload = multer();

router.post('/promote-campaign2', upload.none(), async (req,res) => {
    const campaignId = Number(req.body.campaignId || req.query.campaignId);
    const accessToken = req.accessToken || req.body.accessToken || req.query.accessToken;
    const numberOfUnits = req.body.numberOfUnits || req.query.numberOfUnits;
    const endorsementNote = req.body.endorsementNote || req.query.endorsementNote;

    if (!campaignId) return res.status(400).json({ error:'Campaign ID required' });
    if (!pageId) return res.status(400).json({ error:'PAGE_ID missing' });
    if (!accessToken) return res.status(400).json({ error:'Access token required' });

    const tempFiles = [];
    let finalMediaPath=null;
    let isVideo=false;

    try {
        const pool = req.app.locals.db;
        if (!pool) return res.status(500).json({ error:'DB not connected' });

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
        if (!campaignResult.recordset.length) return res.status(404).json({ error:'Campaign not found' });
        const campaign = campaignResult.recordset[0];

        // Get campaign files
        const filesResult = await pool.request()
            .input('campaignId', sql.Int, campaignId)
            .query('SELECT FilePath, FileType FROM CampaignFiles WHERE CampaignId=@campaignId');

        if (!filesResult.recordset.length) return res.status(400).json({ error:'No campaign files' });

        const downloadedPaths = [];
        const types = [];
        for (const file of filesResult.recordset) {
            const tmp = await downloadFileIfNeeded(file.FilePath);
            tempFiles.push(tmp);
            downloadedPaths.push(tmp);
            types.push(file.FileType.toLowerCase());
        }

        // Identify images
        const images = downloadedPaths.filter((_,i)=> types[i].includes('image')||types[i].includes('jpg')||types[i].includes('jpeg')||types[i].includes('png'));
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
        } else if (downloadedPaths.length===1 && types[0].includes('video')){
            finalMediaPath = downloadedPaths[0];
            isVideo = true;
        } else {
            finalMediaPath = downloadedPaths[0];
            isVideo = false;
        }

        // Post to FB
        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('source', fs.createReadStream(finalMediaPath));
        const message = `${campaign.CampaignTitle}\n${campaign.CampaignDescription}\n${endorsementNote||''}\nLink: ${campaign.CampaignLink}`;
        formData.append('description', message);
        const fbUrl = `https://graph-video.facebook.com/v19.0/${pageId}/${isVideo?'videos':'photos'}`;

        const fbResp = await axios.post(fbUrl, formData, { headers: formData.getHeaders(), maxContentLength:Infinity, maxBodyLength:Infinity });

        const postData = {
            pageId,
            timestamp: Date.now(),
            postId: uuidv4(),
            mediaId: fbResp.data.id,
            type: isVideo?'video':'image',
            campaignId: campaign.CampaignId, // DynamoDB expects Number
            campaignTitle: campaign.CampaignTitle || '',
            campaignDescription: campaign.CampaignDescription || '',
            endorsementNote: endorsementNote || '',
            numberOfUnits: numberOfUnits||0,
            originalFilePaths: filesResult.recordset.map(f=>f.FilePath),
            message,
            status:'posted'
        };
        await createPost(postData);

        res.status(200).json({ success:true, id: fbResp.data.id, postType:isVideo?'video':'image', message });

    } catch(err){
        console.error('Error processing endorsement:', err);
        if(campaignId && pageId){
            try {
                await createPost({ pageId, timestamp: Date.now(), postId: uuidv4(), campaignId: Number(campaignId), status:'failed', errorMessage:err.message });
            } catch(e){ console.error('Failed to log to DynamoDB:', e); }
        }
        res.status(500).json({ error:'Failed to process endorsement', details:err.message });
    } finally {
        tempFiles.forEach(f=>safeUnlink(f));
    }
});

module.exports = router;
