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

async function createVideoWithTransitions(imagePaths, outputVideoPath, totalDuration, audioPath, backgroundMusicPath = null) {
    if (!imagePaths.length) throw new Error('No media frames provided');

    // Remove stale output if it exists
    safeUnlink(outputVideoPath);

    // Ensure output directory exists
    const outputDir = path.dirname(outputVideoPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const hasAudio = audioPath && fs.existsSync(audioPath);
    const hasBackgroundMusic = backgroundMusicPath && fs.existsSync(backgroundMusicPath);
    const durPerMedia = totalDuration / imagePaths.length;

    console.log(`Creating video with ${imagePaths.length} media items, ${durPerMedia.toFixed(2)}s each`);

    // Handle single media case
    if (imagePaths.length === 1) {
        const cmd = ffmpeg();
        const mediaPath = imagePaths[0];
        
        // Check if it's a video by trying to get its properties
        let isVideo = false;
        try {
            const metadata = await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(mediaPath, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
            
            // Check if it has a video stream with duration
            const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
            isVideo = videoStream && parseFloat(metadata.format?.duration || 0) > 0;
        } catch (err) {
            isVideo = false;
        }

        cmd.input(mediaPath);
        
        if (!isVideo) {
            // It's an image - loop it
            cmd.inputOptions(['-loop', '1', '-t', totalDuration.toString()]);
        } else {
            // It's a video - trim or loop as needed
            const videoDuration = await getMediaDuration(mediaPath);
            if (videoDuration < totalDuration) {
                // Loop video to fill duration
                cmd.inputOptions(['-stream_loop', Math.ceil(totalDuration / videoDuration).toString()]);
            }
        }
        
        if (hasAudio) {
            cmd.input(audioPath);
        }

        if (hasBackgroundMusic) {
            cmd.input(backgroundMusicPath);
        }

        const outputOpts = [
            '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p,fps=30',
            '-t', totalDuration.toString(),
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '30',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-threads', '0'
        ];

        if (hasAudio && hasBackgroundMusic) {
            // Mix voiceover with background music
            // VOLUME ADJUSTMENT: Change 0.15 (background music volume, 15%) and 1.0 (voiceover volume, 100%)
            const audioFilter = '[1:a]volume=1.0[voice];[2:a]volume=0.15,aloop=loop=-1:size=2e+09[bg];[voice][bg]amix=inputs=2:duration=shortest[aout]';
            outputOpts.push('-filter_complex', audioFilter, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
        } else if (hasAudio) {
            // Map only the voiceover audio, ignore original video audio
            outputOpts.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '96k', '-shortest');
        } else {
            // No audio at all
            outputOpts.push('-an');
        }

        return new Promise((resolve, reject) => {
            cmd.outputOptions(outputOpts)
               .output(outputVideoPath)
               .on('start', () => console.log('Processing media...'))
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

    // Multiple media items - need to process each differently
    const transitionDuration = 0.5;
    const processedClips = [];
    
    try {
        // Process each media item (video or image)
        for (let i = 0; i < imagePaths.length; i++) {
            const mediaPath = imagePaths[i];
            const clipPath = path.join(TEMP_DIR, `processed_${i}_${uuidv4()}.mp4`);
            
            // Check if it's a video
            let isVideo = false;
            let videoDuration = 0;
            try {
                const metadata = await new Promise((resolve, reject) => {
                    ffmpeg.ffprobe(mediaPath, (err, data) => {
                        if (err) reject(err);
                        else resolve(data);
                    });
                });
                
                const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
                videoDuration = parseFloat(metadata.format?.duration || 0);
                isVideo = videoStream && videoDuration > 0;
            } catch (err) {
                isVideo = false;
            }

            console.log(`Processing media ${i + 1}/${imagePaths.length} (${isVideo ? 'video' : 'image'})`);

            await new Promise((resolve, reject) => {
                const cmd = ffmpeg();
                cmd.input(mediaPath);
                
                if (!isVideo) {
                    // It's an image - loop it for the duration
                    cmd.inputOptions(['-loop', '1', '-t', durPerMedia.toString()]);
                } else {
                    // It's a video - loop if needed
                    if (videoDuration > 0 && videoDuration < durPerMedia) {
                        cmd.inputOptions(['-stream_loop', Math.ceil(durPerMedia / videoDuration).toString()]);
                    }
                }

   cmd.outputOptions([
  '-vf',
  [
    // 1) Scale to fit inside 1080x1920 without distortion
    'scale=1080:1920:force_original_aspect_ratio=decrease',
    // 2) Pad to exactly 1080x1920 (centered)
    'pad=1080:1920:(1080-iw)/2:(1920-ih)/2',
    // 3) Fix aspect ratio + format + fps
    'setsar=1',
    'format=yuv420p',
    'fps=30'
  ].join(','),
  '-t', durPerMedia.toString(),
  '-c:v', 'libx264',
  '-preset', 'ultrafast',
  '-crf', '30',
  '-pix_fmt', 'yuv420p',
  '-an' // still removing source audio
])

                .output(clipPath)
                .on('end', () => {
                    processedClips.push(clipPath);
                    resolve();
                })
                .on('error', (err, stdout, stderr) => {
                    console.error(`Error processing media ${i}:`, stderr);
                    reject(err);
                })
                .run();
            });
        }

        console.log('All media processed, adding transitions...');

        // Now concatenate with transitions
        const cmd = ffmpeg();
        processedClips.forEach(clip => cmd.input(clip));
        
        if (hasAudio) {
            cmd.input(audioPath);
        }

        if (hasBackgroundMusic) {
            cmd.input(backgroundMusicPath);
        }

        // Build filter for transitions (and optionally audio mix)
        const filterParts = [];
        
        // Label each input
        for (let i = 0; i < processedClips.length; i++) {
            filterParts.push(`[${i}:v]null[v${i}]`);
        }

        // Add fade transitions
        let prev = 'v0';
        let offset = durPerMedia - transitionDuration;

        for (let i = 1; i < processedClips.length; i++) {
            const cur = `v${i}`;
            const out = i === processedClips.length - 1 ? 'vout' : `vx${i}`;
            filterParts.push(`[${prev}][${cur}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${out}]`);
            prev = out;
            offset += durPerMedia - transitionDuration;
        }

        const filterSegments = [filterParts.join(';')];

        const outputOpts = [
            '-map', '[vout]',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '30',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-threads', '0'
        ];

        if (hasAudio && hasBackgroundMusic) {
            // Mix voiceover with background music
            // VOLUME ADJUSTMENT: Change 0.15 (background music volume, 15%) and 1.0 (voiceover volume, 100%)
            const audioFilter = `[${processedClips.length}:a]volume=1.0[voice];[${processedClips.length + 1}:a]volume=0.15,aloop=loop=-1:size=2e+09[bg];[voice][bg]amix=inputs=2:duration=shortest[aout]`;
            filterSegments.push(audioFilter);
            cmd.complexFilter(filterSegments.join(';'));
            outputOpts.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
        } else if (hasAudio) {
            cmd.complexFilter(filterSegments.join(';'));
            // Map the voiceover audio (last input)
            outputOpts.push(
                '-map', `${processedClips.length}:a`,
                '-c:a', 'aac',
                '-b:a', '96k',
                '-shortest'
            );
        } else {
            cmd.complexFilter(filterSegments.join(';'));
        }

        cmd.outputOptions(outputOpts).output(outputVideoPath);

        await new Promise((resolve, reject) => {
            cmd.on('start', () => console.log('Creating final video with voiceover...'))
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

        // Cleanup processed clips
        processedClips.forEach(safeUnlink);

    } catch (error) {
        processedClips.forEach(clip => clip && safeUnlink(clip));
        throw error;
    }
}

function buildScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone }) {
    return `
You are an AI video copywriter for IEndorse campaigns.
Write a short but punchy video script using the details below.
Voice Talent: ${voice || 'Default'}
Tone: ${tone || 'Friendly'}

Return JSON ONLY in the following format:
{
  "title": "punchy 5-10 word video title",
  "description": "1-2 sentence summary (max ~200 characters) of the story viewers will hear",
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
            { role: 'system', content: 'You are a seasoned creative director who writes voice-over scripts like a story of their journey. Do not mention the name of the tone or voice' },
            { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 1.0
    });

    const raw = response?.choices?.[0]?.message?.content?.trim() || '';
    try {
        const parsed = JSON.parse(raw);
        if (!parsed.script) throw new Error('Invalid response');
        return {
            script: parsed.script.trim(),
            talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints : [],
            title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : (campaignTitle || 'AI Video'),
            description: typeof parsed.description === 'string' && parsed.description.trim()
                ? parsed.description.trim()
                : (campaignDescription || scriptContext || ''),
            tokensUsed: response?.usage?.total_tokens || null
        };
    } catch (err) {
        return {
            script: raw,
            talkingPoints: [],
            title: campaignTitle || 'AI Video',
            description: campaignDescription || scriptContext || '',
            tokensUsed: response?.usage?.total_tokens || null
        };
    }
}

async function synthesizeVoiceOver({ script, voice, tone, apiKey }) {
    if (!apiKey) throw new Error('OpenAI API key missing for TTS');

    const ttsVoice = OPENAI_TTS_VOICE_MAP[voice] || 'alloy';
    const openai = new OpenAI({ apiKey });
    const audioPath = path.join(TEMP_DIR, `voice_${uuidv4()}.mp3`);

    // Feed the script directly; prefixing the tone gets read aloud.
    const ttsInput = script;

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
            title: scriptResponse.title,
            description: scriptResponse.description,
            tokensUsed: scriptResponse.tokensUsed
        });
    } catch (err) {
        console.error('AI video script error:', err);
        res.status(500).json({ error: 'Failed to generate script', details: err.message });
    }
});

router.post('/ai-video/generate-video', upload.none(), async (req, res) => {
    let { script, voice = 'Ava', tone = 'Friendly', media, backgroundMusic } = req.body;

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
    let backgroundMusicPath = null;
    let finalVideoPath = null;

    try {
        audioPath = await synthesizeVoiceOver({
            script,
            voice,
            tone,
            apiKey: req.openai_api_key || process.env.OPENAI_API_KEY
        });
        
        // Handle background music: use provided filename or pick random from uploads/audio
        const audioDir = path.join(__dirname, '..', 'uploads', 'audio');
        if (!backgroundMusic && fs.existsSync(audioDir)) {
            const candidates = (fs.readdirSync(audioDir) || []).filter(name =>
                name.toLowerCase().match(/\.(mp3|wav|m4a|aac)$/)
            );
            if (candidates.length) {
                backgroundMusic = candidates[Math.floor(Math.random() * candidates.length)];
            }
        }

        if (backgroundMusic) {
            const musicFile = path.join(audioDir, backgroundMusic);
            if (fs.existsSync(musicFile)) {
                backgroundMusicPath = musicFile;
                console.log('Using background music:', backgroundMusic);
            } else {
                console.warn('Background music file not found:', backgroundMusic);
            }
        }
        
        const mediaPaths = [];

        // Download all media files
        for (let i = 0; i < media.length; i++) {
            const mediaItem = media[i];
            if (!mediaItem?.filePath) continue;

            const localPath = await downloadFileIfNeeded(mediaItem.filePath);
            tempFiles.push(localPath);
            
            // Keep videos as videos, images as images
            mediaPaths.push(localPath);
        }

        if (!mediaPaths.length) {
            throw new Error('No usable media files were provided');
        }

        const audioDuration = await getMediaDuration(audioPath).catch(() => 0);
        const fallbackDuration = mediaPaths.length * 4;
        const totalDuration = audioDuration > 0 ? audioDuration : fallbackDuration;

        finalVideoPath = path.join(TEMP_DIR, `ai_video_${uuidv4()}.mp4`);
        
        // Pass the actual media files (videos and images) and background music to the function
        await createVideoWithTransitions(mediaPaths, finalVideoPath, totalDuration, audioPath, backgroundMusicPath);

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
            duration: totalDuration,
            backgroundMusic: backgroundMusic || null
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
