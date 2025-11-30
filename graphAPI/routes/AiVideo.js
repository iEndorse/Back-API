const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require('openai');

// Resolve ffmpeg binary dynamically (env -> ffmpeg-static -> PATH)
let resolvedFfmpeg = process.env.FFMPEG_PATH;
if (!resolvedFfmpeg) {
    try { resolvedFfmpeg = require('ffmpeg-static'); } catch (_) { /* optional */ }
}
if (!resolvedFfmpeg || (path.isAbsolute(resolvedFfmpeg) && !fs.existsSync(resolvedFfmpeg))) {
    resolvedFfmpeg = 'ffmpeg';
}
ffmpeg.setFfmpegPath(resolvedFfmpeg);

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const videoJobs = new Map();
const upload = multer();

// Map UI voice labels to OpenAI TTS voices
const OPENAI_TTS_VOICE_MAP = {
    Ava: 'alloy',
    Noah: 'verse',
    Sofia: 'shimmer',
    Mason: 'onyx'
};

function safeUnlink(filePath) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function cleanupJob(jobId) {
    const job = videoJobs.get(jobId);
    if (!job) return;
    safeUnlink(job.path);
    safeUnlink(job.audioPath);
    videoJobs.delete(jobId);
}

function getActiveJob(jobId) {
    const job = videoJobs.get(jobId);
    if (!job) return null;
    if (Date.now() > job.expiresAt) {
        cleanupJob(jobId);
        return null;
    }
    return job;
}

function inferMimeType(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    switch (ext) {
        case '.mp4':
            return 'video/mp4';
        case '.mov':
            return 'video/quicktime';
        case '.avi':
            return 'video/x-msvideo';
        case '.mkv':
            return 'video/x-matroska';
        default:
            return 'application/octet-stream';
    }
}

async function downloadFileIfNeeded(filePath) {
    if (!filePath) throw new Error('Media filePath is required');
    const filename = `${uuidv4()}_${path.basename(filePath).replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const tempPath = path.join(TEMP_DIR, filename);

    if (filePath.startsWith('http')) {
        const response = await axios({
            method: 'get',
            url: filePath,
            responseType: 'stream'
        });
        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(tempPath);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } else {
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        fs.copyFileSync(filePath, tempPath);
    }
    return tempPath;
}

function isVideoFile(filePath = '', fileType = '') {
    const value = `${filePath} ${fileType}`.toLowerCase();
    return ['.mp4', '.mov', '.mkv', '.webm', '.avi'].some(ext => value.includes(ext)) || value.includes('video');
}

function convertImageToPng(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions(['-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

function extractFrameFromVideo(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: ['0'],
                filename: path.basename(outputPath),
                folder: path.dirname(outputPath)
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

function getMediaDuration(mediaPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(mediaPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(parseFloat(metadata?.format?.duration) || 0);
        });
    });
}

async function createVideoWithTransitions(imagePaths, outputVideoPath, totalDuration, audioPath) {
    if (!imagePaths.length) throw new Error('No media frames provided');

    // Verify all input images exist
    for (const imgPath of imagePaths) {
        if (!fs.existsSync(imgPath)) {
            throw new Error(`Image not found: ${imgPath}`);
        }
    }

    // Remove stale output if it exists
    safeUnlink(outputVideoPath);

    // Ensure output directory exists
    const outputDir = path.dirname(outputVideoPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const hasAudio = audioPath && fs.existsSync(audioPath);
    const transitionDuration = 0.5;
    const durPerImage = totalDuration / imagePaths.length;

    console.log(`Creating video with ${imagePaths.length} images, ${durPerImage.toFixed(2)}s each`);

    // Ultra-fast approach: simple scale + fade transitions only
    const cmd = ffmpeg();
    
    // Add all images as inputs
    imagePaths.forEach((imgPath) => {
        cmd.input(imgPath).inputOptions(['-loop', '1', '-t', durPerImage.toString()]);
    });
    
    if (hasAudio) {
        cmd.input(audioPath);
    }

    // Simple filter: scale and fade transitions only (no zoom effects for speed)
    const filterParts = [];
    
    // Scale each image to 1080p
    for (let i = 0; i < imagePaths.length; i++) {
        filterParts.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p,fps=30[v${i}]`);
    }

    // Add fade transitions between images
    let prev = 'v0';
    let offset = durPerImage - transitionDuration;

    for (let i = 1; i < imagePaths.length; i++) {
        const cur = `v${i}`;
        const out = i === imagePaths.length - 1 ? 'vout' : `vx${i}`;
        filterParts.push(`[${prev}][${cur}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${out}]`);
        prev = out;
        offset += durPerImage - transitionDuration;
    }

    const filterComplex = filterParts.join(';');
    cmd.complexFilter(filterComplex);

    // Ultra-fast encoding settings
    const outputOpts = [
        '-map', '[vout]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Fastest preset
        '-crf', '30', // Lower quality for speed
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-threads', '0' // Use all CPU cores
    ];

    if (hasAudio) {
        outputOpts.push(
            '-map', `${imagePaths.length}:a`,
            '-c:a', 'aac',
            '-b:a', '96k', // Lower audio bitrate
            '-shortest'
        );
    }

    cmd.outputOptions(outputOpts).output(outputVideoPath);

    await new Promise((resolve, reject) => {
        cmd.on('start', () => {
            console.log('Processing video (fast mode)...');
        })
        .on('progress', (progress) => {
            if (progress.percent) {
                console.log('Progress: ' + Math.round(progress.percent) + '%');
            }
        })
        .on('end', () => {
            console.log('Video created!');
            resolve();
        })
        .on('error', (err, stdout, stderr) => {
            console.error('FFmpeg error:', stderr);
            reject(err);
        })
        .run();
    });
}

function buildScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone }) {
    return `
You are an AI video copywriter for IEndorse campaigns.
Write a short but punchy video script using the details below.
Voice Talent: ${voice || 'Default'}
Tone: ${tone || 'Friendly'}

Return JSON ONLY in the following format:
{
  "script": "full script text",
  "talkingPoints": ["bullet 1", "bullet 2"]
}

Campaign Title: ${campaignTitle || 'Untitled Campaign'}
Campaign Description: ${campaignDescription || 'N/A'}
Additional Context: ${scriptContext || 'N/A'}
`;
}

async function requestScriptFromOpenAI({ apiKey, campaignTitle, campaignDescription, scriptContext, voice, tone }) {
    if (!apiKey) throw new Error('OpenAI API key missing');
    const openai = new OpenAI({ apiKey });
    const prompt = buildScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone });

    const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
            { role: 'system', content: 'You are a seasoned creative director who writes voice-over scripts.' },
            { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.7
    });

    const raw = response?.choices?.[0]?.message?.content?.trim() || '';
    try {
        const parsed = JSON.parse(raw);
        if (!parsed.script) throw new Error('Invalid response');
        return {
            script: parsed.script.trim(),
            talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints : [],
            tokensUsed: response?.usage?.total_tokens || null
        };
    } catch (err) {
        return {
            script: raw,
            talkingPoints: [],
            tokensUsed: response?.usage?.total_tokens || null
        };
    }
}

async function synthesizeVoiceOver({ script, voice, tone, apiKey }) {
    if (!apiKey) throw new Error('OpenAI API key missing for TTS');

    const ttsVoice = OPENAI_TTS_VOICE_MAP[voice] || 'alloy';
    const openai = new OpenAI({ apiKey });
    const audioPath = path.join(TEMP_DIR, `voice_${uuidv4()}.mp3`);

    // Prefix tone to help guide delivery; OpenAI TTS does not have a style knob.
    const ttsInput = tone ? `Tone: ${tone}. ${script}` : script;

    const response = await openai.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: ttsVoice,
        input: ttsInput
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(audioPath, buffer);
    return audioPath;
}

function registerJob({ filePath, audioPath, script, voice, tone, duration }) {
    const jobId = uuidv4();
    const record = {
        id: jobId,
        path: filePath,
        audioPath,
        script,
        voice,
        tone,
        duration,
        createdAt: Date.now(),
        expiresAt: Date.now() + JOB_TTL_MS,
        filename: path.basename(filePath)
    };
    videoJobs.set(jobId, record);
    const timeout = setTimeout(() => cleanupJob(jobId), JOB_TTL_MS);
    if (typeof timeout.unref === 'function') timeout.unref();
    return record;
}

router.post('/ai-video/script', upload.none(), async (req, res) => {
    const {
        campaignTitle,
        campaignDescription,
        scriptContext,
        voice = 'Ava',
        tone = 'Friendly'
    } = req.body;

    if (!campaignDescription && !scriptContext) {
        return res.status(400).json({ error: 'Provide campaignDescription or scriptContext' });
    }

    try {
        const scriptResponse = await requestScriptFromOpenAI({
            apiKey: req.openai_api_key || process.env.OPENAI_API_KEY,
            campaignTitle,
            campaignDescription,
            scriptContext,
            voice,
            tone
        });

        res.json({
            script: scriptResponse.script,
            talkingPoints: scriptResponse.talkingPoints,
            voice,
            tone,
            tokensUsed: scriptResponse.tokensUsed
        });
    } catch (err) {
        console.error('AI video script error:', err);
        res.status(500).json({ error: 'Failed to generate script', details: err.message });
    }
});

router.post('/ai-video/generate-video', upload.none(), async (req, res) => {
    let { script, voice = 'Ava', tone = 'Friendly', media } = req.body;

    if (!script || typeof script !== 'string') {
        return res.status(400).json({ error: 'Script text is required' });
    }

    if (typeof media === 'string') {
        try {
            media = JSON.parse(media);
        } catch (err) {
            return res.status(400).json({ error: 'Media payload must be valid JSON array' });
        }
    }

    if (!Array.isArray(media) || !media.length) {
        return res.status(400).json({ error: 'Media array is required' });
    }

    const tempFiles = [];
    let audioPath = null;
    let finalVideoPath = null;

    try {
        audioPath = await synthesizeVoiceOver({
            script,
            voice,
            tone,
            apiKey: req.openai_api_key || process.env.OPENAI_API_KEY
        });
        const orderedFrames = [];

        for (let i = 0; i < media.length; i++) {
            const mediaItem = media[i];
            if (!mediaItem?.filePath) continue;

            const localPath = await downloadFileIfNeeded(mediaItem.filePath);
            tempFiles.push(localPath);

            const video = isVideoFile(mediaItem.filePath, mediaItem.fileType);
            let framePath = localPath;

            if (video) {
                const stillPath = path.join(TEMP_DIR, `frame_${i}_${uuidv4()}.png`);
                await extractFrameFromVideo(localPath, stillPath);
                framePath = stillPath;
            }

            if (!framePath.endsWith('.png')) {
                const pngPath = path.join(TEMP_DIR, `img_${i}_${uuidv4()}.png`);
                await convertImageToPng(framePath, pngPath);
                framePath = pngPath;
            }

            orderedFrames.push(framePath);
        }

        if (!orderedFrames.length) {
            throw new Error('No usable media files were provided');
        }

        const audioDuration = await getMediaDuration(audioPath).catch(() => 0);
        const fallbackDuration = orderedFrames.length * 4; // only used if audio missing
        const totalDuration = audioDuration > 0 ? audioDuration : fallbackDuration;

        finalVideoPath = path.join(TEMP_DIR, `ai_video_${uuidv4()}.mp4`);
        await createVideoWithTransitions(orderedFrames, finalVideoPath, totalDuration, audioPath);
        orderedFrames.forEach(safeUnlink);

        const job = registerJob({
            filePath: finalVideoPath,
            audioPath,
            script,
            voice,
            tone,
            duration: totalDuration
        });

        res.json({
            jobId: job.id,
            downloadUrl: `/ai-video/video/${job.id}`,
            expiresAt: new Date(job.expiresAt).toISOString(),
            voice,
            tone,
            script,
            duration: totalDuration
        });
    } catch (err) {
        console.error('AI video generation error:', err);
        tempFiles.forEach(safeUnlink);
        safeUnlink(audioPath);
        safeUnlink(finalVideoPath);
        return res.status(500).json({ error: 'Failed to generate AI video', details: err.message });
    } finally {
        tempFiles.forEach(safeUnlink);
    }
});

router.get('/ai-video/jobs/:jobId', (req, res) => {
    const job = getActiveJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });

    res.json({
        jobId: job.id,
        filename: job.filename,
        downloadUrl: `/ai-video/video/${job.id}`,
        expiresAt: new Date(job.expiresAt).toISOString(),
        voice: job.voice,
        tone: job.tone,
        script: job.script,
        duration: job.duration
    });
});

router.delete('/ai-video/jobs/:jobId', (req, res) => {
    const job = videoJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    cleanupJob(req.params.jobId);
    res.json({ success: true });
});

router.get('/ai-video/video/:jobId', (req, res) => {
    const job = getActiveJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Video not found or expired' });

    const mimeType = inferMimeType(job.path);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${job.filename}"`);
    res.sendFile(path.resolve(job.path), (err) => {
        if (err) {
            console.error('Error streaming AI video:', err);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to stream media file' });
        }
    });
});

module.exports = router;