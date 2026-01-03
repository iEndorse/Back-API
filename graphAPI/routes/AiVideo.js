const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require('openai');
const AWS = require('aws-sdk');
const sql = require('mssql');

// Resolve ffmpeg binary dynamically
let resolvedFfmpeg = process.env.FFMPEG_PATH;
if (!resolvedFfmpeg) {
    try { resolvedFfmpeg = require('ffmpeg-static'); } catch (_) {}
}
if (!resolvedFfmpeg || (path.isAbsolute(resolvedFfmpeg) && !fs.existsSync(resolvedFfmpeg))) {
    resolvedFfmpeg = 'ffmpeg';
}
ffmpeg.setFfmpegPath(resolvedFfmpeg);

let resolvedFfprobe = process.env.FFPROBE_PATH;
if (!resolvedFfprobe) {
    try { resolvedFfprobe = require('ffprobe-static')?.path; } catch (_) {}
}
if (!resolvedFfprobe || (path.isAbsolute(resolvedFfprobe) && !fs.existsSync(resolvedFfprobe))) {
    resolvedFfprobe = 'ffprobe';
}
ffmpeg.setFfprobePath(resolvedFfprobe);

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const TEMP_DIR = process.env.AWS_EXECUTION_ENV ? '/tmp' : path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const JOB_TTL_MS = 60 * 60 * 1000;
const videoJobs = new Map();
const upload = multer();

// S3 Configuration
const S3_BUCKET = 'iendorse-audio-assets';
const S3_AUDIO_PREFIX = 'background-music/';
const S3_VIDEO_PREFIX = 'ai-generated-videos/';

// Costs
const SCRIPT_GENERATION_COST = 20;
const VIDEO_GENERATION_COST = 50;

// Voice mapping
const OPENAI_TTS_VOICE_MAP = {
    Ava: 'alloy',
    Noah: 'verse',
    Sofia: 'shimmer',
    Mason: 'onyx'
};

/* ============================
   🎬 PEXELS INTEGRATION
============================ */

// Extract meaningful keywords from text
function extractKeywords(text) {
  if (!text) return [];
  
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
    'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'will', 'with',
    'we', 'you', 'your', 'our', 'this', 'these', 'those', 'can', 'could', 'should',
    'would', 'may', 'might', 'must', 'have', 'had', 'been', 'being', 'do', 'does',
    'did', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'up', 'down', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very'
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !stopWords.has(word));

  const frequency = {};
  words.forEach(word => {
    frequency[word] = (frequency[word] || 0) + 1;
  });

  return Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 5);
}

// Build intelligent search query
function buildPexelsSearchQuery({ scriptTitle, scriptDescription, scriptText }) {
  const titleKeywords = extractKeywords(scriptTitle);
  const descKeywords = extractKeywords(scriptDescription);
  const scriptKeywords = extractKeywords(scriptText);

  const allKeywords = [
    ...titleKeywords.slice(0, 3),
    ...descKeywords.slice(0, 2),
    ...scriptKeywords.slice(0, 2)
  ];

  const uniqueKeywords = [...new Set(allKeywords)];

  if (uniqueKeywords.length > 0) {
    return uniqueKeywords.slice(0, 3).join(' ');
  }

  return 'business professional';
}

// Fetch video from Pexels
async function fetchPexelsVideo({ apiKey, scriptTitle, scriptDescription, scriptText }) {
  if (!apiKey) throw new Error('Pexels API key not configured');

  const query = buildPexelsSearchQuery({ scriptTitle, scriptDescription, scriptText });
  
  console.log(`[Pexels] Searching for: "${query}"`);
  
  try {
    const response = await axios.get('https://api.pexels.com/videos/search', {
      params: {
        query,
        orientation: 'portrait',
        size: 'medium',
        per_page: 15
      },
      headers: {
        'Authorization': apiKey
      },
      timeout: 10000
    });

    const videos = response.data?.videos || [];
    if (!videos.length) {
      const keywords = extractKeywords(scriptTitle || scriptDescription || scriptText || '');
      const fallbackQuery = keywords[0] || 'business professional';
      
      console.log(`[Pexels] No results, trying fallback: "${fallbackQuery}"`);
      
      const fallbackResponse = await axios.get('https://api.pexels.com/videos/search', {
        params: {
          query: fallbackQuery,
          orientation: 'portrait',
          size: 'medium',
          per_page: 15
        },
        headers: {
          'Authorization': apiKey
        },
        timeout: 10000
      });
      const fallbackVideos = fallbackResponse.data?.videos || [];
      if (!fallbackVideos.length) throw new Error('No videos found on Pexels');
      return fallbackVideos[Math.floor(Math.random() * fallbackVideos.length)];
    }

    return videos[Math.floor(Math.random() * videos.length)];
  } catch (err) {
    throw new Error(`Pexels API error: ${err.message}`);
  }
}

// Download Pexels video
async function downloadPexelsVideo({ apiKey, scriptTitle, scriptDescription, scriptText }) {
  const video = await fetchPexelsVideo({ apiKey, scriptTitle, scriptDescription, scriptText });
  
  const videoFiles = video.video_files || [];
  const portraitFile = videoFiles.find(f => 
    f.width && f.height && f.height > f.width && f.quality === 'hd'
  ) || videoFiles.find(f => 
    f.width && f.height && f.height > f.width
  ) || videoFiles[0];

  if (!portraitFile?.link) throw new Error('No suitable video file found');

  const localPath = path.join(TEMP_DIR, `pexels_${uuidv4()}.mp4`);
  
  console.log(`[Pexels] Downloading video from: ${portraitFile.link}`);
  
  const response = await axios({
    method: 'get',
    url: portraitFile.link,
    responseType: 'stream',
    timeout: 60000
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(localPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  console.log(`[Pexels] Video downloaded successfully`);
  return localPath;
}

/* ============================
   UTILITY FUNCTIONS
============================ */

router.post('/ai-video/voice-sample', async (req, res) => {
  const { voice = 'alloy' } = req.body;

  const voiceMap = {
    Ava: 'alloy',
    Noah: 'echo',
    Sofia: 'shimmer',
    Mason: 'onyx',
  };

  const allowedVoices = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
  const openaiVoice = allowedVoices.has(voice) ? voice : (voiceMap[voice] || 'alloy');

  try {
    const openai = new OpenAI({
      apiKey: req.openai_api_key || process.env.OPENAI_API_KEY,
    });

    console.log(`Generating voice sample for "${voice}" -> "${openaiVoice}"`);

    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: openaiVoice,
      input: `Hello! This is ${voice} speaking. I'm here to help you create amazing content.`,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `inline; filename="voice-sample-${openaiVoice}.mp3"`,
      "Cache-Control": "no-store",
    });

    return res.status(200).end(buffer);

  } catch (error) {
    console.error('Error generating voice sample:', error);
    return res.status(500).json({
      error: 'Failed to generate voice sample',
      details: error?.message || String(error),
    });
  }
});

function safeUnlink(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            console.error('Error deleting file:', filePath, err);
        }
    }
}

function cleanupJob(jobId) {
    const job = videoJobs.get(jobId);
    if (!job) return;
    if (job.path && !job.path.startsWith('http')) {
        safeUnlink(job.path);
    }
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

function cleanupOrphanedTempFiles() {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        
        const files = fs.readdirSync(TEMP_DIR);
        const oneHourAgo = Date.now() - JOB_TTL_MS;
        
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (stats.mtimeMs < oneHourAgo) {
                    console.log('Cleaning up orphaned file:', file);
                    safeUnlink(filePath);
                }
            } catch (err) {
                console.error(`Error checking file ${file}:`, err);
            }
        });
        
        console.log('Temp directory cleanup complete');
    } catch (err) {
        console.error('Error cleaning up temp files:', err);
    }
}

cleanupOrphanedTempFiles();

function inferMimeType(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    switch (ext) {
        case '.mp4': return 'video/mp4';
        case '.mov': return 'video/quicktime';
        case '.avi': return 'video/x-msvideo';
        case '.mkv': return 'video/x-matroska';
        default: return 'application/octet-stream';
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

function getMediaDuration(mediaPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(mediaPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(parseFloat(metadata?.format?.duration) || 0);
        });
    });
}

async function createVideoWithTransitions(
  imagePaths,
  outputVideoPath,
  totalDuration,
  audioPath,
  backgroundMusicPath = null
) {
  if (!imagePaths.length) throw new Error('No media frames provided');

  safeUnlink(outputVideoPath);

  const outputDir = path.dirname(outputVideoPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const hasAudio = audioPath && fs.existsSync(audioPath);
  const hasBackgroundMusic = backgroundMusicPath && fs.existsSync(backgroundMusicPath);

  const MAX_CLIP_DURATION = 10;
  const durPerMedia = Math.min(MAX_CLIP_DURATION, totalDuration / imagePaths.length);
  const singlePassDuration = durPerMedia * imagePaths.length;
  const loopsNeeded = Math.max(1, Math.ceil(totalDuration / singlePassDuration));

  console.log(
    `Creating video: ${imagePaths.length} media items, ` +
      `${durPerMedia.toFixed(2)}s each, ${loopsNeeded} loop(s), total: ${totalDuration}s`
  );

  // Single media case
  if (imagePaths.length === 1) {
    const mediaPath = imagePaths[0];
    const ext = path.extname(mediaPath).toLowerCase();
    const isImageExt = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext);

    const cmd = ffmpeg();
    cmd.input(mediaPath);

    let isVideo = false;
    let videoDuration = 0;

    if (!isImageExt) {
      try {
        const metadata = await new Promise((resolve, reject) => {
          ffmpeg.ffprobe(mediaPath, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });

        const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
        videoDuration = parseFloat(metadata.format?.duration || 0) || 0;
        isVideo = !!(videoStream && videoDuration > 0);
      } catch (err) {
        isVideo = false;
        videoDuration = 0;
      }
    }

    if (!isVideo) {
      cmd.inputOptions(['-loop', '1', '-t', totalDuration.toString()]);
    } else {
      if (videoDuration < totalDuration - 0.1) {
        let loops = Math.ceil(totalDuration / videoDuration);
        const MAX_VIDEO_LOOPS = 10;
        if (loops > MAX_VIDEO_LOOPS) loops = MAX_VIDEO_LOOPS;
        console.log(`Single media: looping video ${loops} times to fill ~${totalDuration}s`);
        cmd.inputOptions(['-stream_loop', (loops - 1).toString()]);
      } else {
        console.log(`Single media: trimming video from ${videoDuration}s to ${totalDuration}s`);
      }
    }

    if (hasAudio) cmd.input(audioPath);
    if (hasBackgroundMusic) cmd.input(backgroundMusicPath);

    const outputOpts = [
      '-vf',
      [
        'scale=1080:1920:force_original_aspect_ratio=decrease',
        'pad=1080:1920:(1080-iw)/2:(1920-ih)/2',
        'setsar=1',
        'format=yuv420p',
        'fps=30',
      ].join(','),
      '-t', totalDuration.toString(),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '30',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-threads', '0',
    ];

    if (hasAudio && hasBackgroundMusic) {
      const audioFilter =
        '[1:a]volume=1.0[voice];' +
        '[2:a]volume=0.15,aloop=loop=-1:size=2e+09[bg];' +
        '[voice][bg]amix=inputs=2:duration=shortest[aout]';
      outputOpts.push(
        '-filter_complex', audioFilter,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:a', 'aac',
        '-b:a', '128k'
      );
    } else if (hasAudio) {
      outputOpts.push(
        '-map', '0:v',
        '-map', '1:a',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-shortest'
      );
    } else {
      outputOpts.push('-an');
    }

    return new Promise((resolve, reject) => {
      cmd
        .outputOptions(outputOpts)
        .output(outputVideoPath)
        .on('start', () => console.log('Processing single media...'))
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

  // Multiple media case
  const transitionDuration = 2.5;
  const processedClips = [];

  try {
    for (let i = 0; i < imagePaths.length; i++) {
      const mediaPath = imagePaths[i];
      const clipPath = path.join(TEMP_DIR, `processed_${i}_${uuidv4()}.mp4`);

      const ext = path.extname(mediaPath).toLowerCase();
      const isImageExt = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext);

      let isVideo = false;
      let videoDuration = 0;

      if (!isImageExt) {
        try {
          const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(mediaPath, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });

          const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
          videoDuration = parseFloat(metadata.format?.duration || 0) || 0;
          isVideo = !!(videoStream && videoDuration > 0);
        } catch (err) {
          isVideo = false;
          videoDuration = 0;
        }
      }

      console.log(
        `Processing media ${i + 1}/${imagePaths.length} ` +
          `(${isVideo ? 'video' : 'image'}, target: ${durPerMedia}s)`
      );

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg();
        cmd.input(mediaPath);

        if (!isVideo) {
          cmd.inputOptions(['-loop', '1', '-t', durPerMedia.toString()]);
        } else {
          if (videoDuration < durPerMedia - 0.1) {
            let loops = Math.ceil(durPerMedia / videoDuration);
            const MAX_VIDEO_LOOPS = 10;
            if (loops > MAX_VIDEO_LOOPS) loops = MAX_VIDEO_LOOPS;
            console.log(`  Looping video ${loops} times to fill ~${durPerMedia}s`);
            cmd.inputOptions(['-stream_loop', (loops - 1).toString()]);
          } else {
            console.log(`  Trimming video from ${videoDuration}s to ${durPerMedia}s`);
          }
        }

        cmd
          .outputOptions([
            '-vf',
            [
              'scale=1080:1920:force_original_aspect_ratio=decrease',
              'pad=1080:1920:(1080-iw)/2:(1920-ih)/2',
              'setsar=1',
              'format=yuv420p',
              'fps=30',
            ].join(','),
            '-t', durPerMedia.toString(),
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '30',
            '-pix_fmt', 'yuv420p',
            '-an',
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

    console.log(`All media processed. Creating ${loopsNeeded} loop(s) with transitions...`);

    const cmd = ffmpeg();

    for (let loop = 0; loop < loopsNeeded; loop++) {
      processedClips.forEach((clip) => cmd.input(clip));
    }

    if (hasAudio) cmd.input(audioPath);
    if (hasBackgroundMusic) cmd.input(backgroundMusicPath);

    const totalClips = processedClips.length * loopsNeeded;

    const filterParts = [];

    for (let i = 0; i < totalClips; i++) {
      filterParts.push(`[${i}:v]null[v${i}]`);
    }

    let prev = 'v0';
    let offset = durPerMedia - transitionDuration;

    for (let i = 1; i < totalClips; i++) {
      const cur = `v${i}`;
      const out = i === totalClips - 1 ? 'vout' : `vx${i}`;
      filterParts.push(
        `[${prev}][${cur}]xfade=transition=fade:` +
          `duration=${transitionDuration}:offset=${offset.toFixed(2)}[${out}]`
      );
      prev = out;
      offset += durPerMedia - transitionDuration;
    }

    const filterSegments = [filterParts.join(';')];

    const outputOpts = [
      '-map', '[vout]',
      '-t', totalDuration.toString(),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '30',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-threads', '0',
    ];

    if (hasAudio && hasBackgroundMusic) {
      const audioFilter =
        `[${totalClips}:a]volume=1.0[voice];` +
        `[${totalClips + 1}:a]volume=0.15,aloop=loop=-1:size=2e+09[bg];` +
        `[voice][bg]amix=inputs=2:duration=shortest[aout]`;
      filterSegments.push(audioFilter);
      cmd.complexFilter(filterSegments.join(';'));
      outputOpts.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
    } else if (hasAudio) {
      cmd.complexFilter(filterSegments.join(';'));
      outputOpts.push(
        '-map', `${totalClips}:a`,
        '-c:a', 'aac',
        '-b:a', '96k',
        '-shortest'
      );
    } else {
      cmd.complexFilter(filterSegments.join(';'));
    }

    cmd.outputOptions(outputOpts).output(outputVideoPath);

    await new Promise((resolve, reject) => {
      cmd
        .on('start', () => console.log('Creating final video with looped clips...'))
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

    processedClips.forEach((clip) => safeUnlink(clip));
  } catch (error) {
    processedClips.forEach((clip) => clip && safeUnlink(clip));
    throw error;
  }
}

function buildScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone }) {
    return `
You are an AI video copywriter for IEndorse campaigns.
Write a short but punchy video script that ALWAYS includes the company name inside the video title using the details below.
Voice Talent: ${voice || 'Default'}
Tone: ${tone || 'Friendly'}

Return JSON ONLY in the following format:
{
  "title": "punchy 5-10 word video title",
  "description": "1-2 sentence summary (max ~200 characters) of the story viewers will hear",
  "script": "full script text",
  "talkingPoints": ["bullet 1", "bullet 2"]
}

Campaign Title (MUST include company name): ${campaignTitle || 'Untitled Campaign'}
Campaign Description: ${campaignDescription || 'N/A'}
Additional Context: ${scriptContext || 'N/A'}
`;
}

async function requestScriptFromOpenAI({ apiKey, campaignTitle, campaignDescription, scriptContext, voice, tone, accountId, pool }) {
    if (!pool) {
        console.error("Database connection not available!");
        throw new Error('Database connection not available.');
    }

    if (!accountId) {
        throw new Error('Account ID is required.');
    }

    const walletQuery = `
        SELECT a.Id, a.WalletUnits
        FROM Accounts AS a
        WHERE a.Id = @accountId;
    `;

    console.log("Executing database query with accountId:", accountId);

    const result = await pool.request()
        .input('accountId', sql.Int, parseInt(accountId, 10))
        .query(walletQuery);

    console.log("Query result count:", result.recordset.length);

    if (result.recordset.length === 0) {
        throw new Error('Account not found.');
    }

    const account = result.recordset[0];
    console.log("Account found:", account.Id);
    console.log("Wallet units:", account.WalletUnits);

    if (account.WalletUnits < SCRIPT_GENERATION_COST) {
        throw new Error(`Insufficient wallet units. You have ${account.WalletUnits} units but need ${SCRIPT_GENERATION_COST} units to generate a script.`);
    }

    console.log(`Wallet unit check passed. Account has sufficient units (required: ${SCRIPT_GENERATION_COST}).`);

    if (!apiKey) throw new Error('OpenAI API key missing');
    const openai = new OpenAI({ apiKey });
    const prompt = buildScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone });

    console.log("Calling OpenAI API to generate script...");

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
    
    if (!raw) {
        throw new Error('OpenAI returned an empty response');
    }

    let scriptResult;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed.script) throw new Error('Invalid response from OpenAI - missing script field');
        scriptResult = {
            script: parsed.script.trim(),
            talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints : [],
            title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : (campaignTitle || 'AI Video'),
            description: typeof parsed.description === 'string' && parsed.description.trim()
                ? parsed.description.trim()
                : (campaignDescription || scriptContext || ''),
            tokensUsed: response?.usage?.total_tokens || null
        };
    } catch (err) {
        console.log("OpenAI response was not JSON, using raw text as script");
        scriptResult = {
            script: raw,
            talkingPoints: [],
            title: campaignTitle || 'AI Video',
            description: campaignDescription || scriptContext || '',
            tokensUsed: response?.usage?.total_tokens || null
        };
    }

    console.log(`Script generated successfully, now deducting ${SCRIPT_GENERATION_COST} wallet units...`);

    const updateQuery = `
        UPDATE Accounts
        SET WalletUnits = WalletUnits - @cost
        WHERE Id = @accountId;
    `;

    await pool.request()
        .input('accountId', sql.Int, parseInt(accountId, 10))
        .input('cost', sql.Int, SCRIPT_GENERATION_COST)
        .query(updateQuery);

    const newBalance = account.WalletUnits - SCRIPT_GENERATION_COST;
    console.log(`Successfully deducted ${SCRIPT_GENERATION_COST} units from account:`, accountId);
    console.log("New wallet balance:", newBalance);

    scriptResult.walletUnitsDeducted = SCRIPT_GENERATION_COST;
    scriptResult.remainingWalletUnits = newBalance;

    return scriptResult;
}

async function synthesizeVoiceOver({ script, voice, tone, apiKey }) {
    if (!apiKey) throw new Error('OpenAI API key missing for TTS');

    const ttsVoice = OPENAI_TTS_VOICE_MAP[voice] || 'alloy';
    const openai = new OpenAI({ apiKey });
    const audioPath = path.join(TEMP_DIR, `voice_${uuidv4()}.mp3`);

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

async function downloadBackgroundMusicFromS3(backgroundMusic) {
    const s3 = new AWS.S3();
    
    if (backgroundMusic) {
        const s3Key = `${S3_AUDIO_PREFIX}${backgroundMusic}`;
        const localPath = path.join(TEMP_DIR, `bg_${uuidv4()}.mp3`);
        
        try {
            console.log(`Downloading background music from S3: ${s3Key}`);
            const params = {
                Bucket: S3_BUCKET,
                Key: s3Key
            };
            const data = await s3.getObject(params).promise();
            fs.writeFileSync(localPath, data.Body);
            console.log('Background music downloaded successfully');
            return localPath;
        } catch (err) {
            console.warn('Failed to download background music from S3:', err.message);
            return null;
        }
    } else {
        try {
            console.log('Fetching random background music from S3...');
            const listParams = {
                Bucket: S3_BUCKET,
                Prefix: S3_AUDIO_PREFIX
            };
            const s3Files = await s3.listObjectsV2(listParams).promise();
            const audioFiles = (s3Files.Contents || [])
                .map(obj => obj.Key)
                .filter(key => key.toLowerCase().match(/\.(mp3|wav|m4a|aac)$/));
            
            if (audioFiles.length > 0) {
                const randomKey = audioFiles[Math.floor(Math.random() * audioFiles.length)];
                const localPath = path.join(TEMP_DIR, `bg_${uuidv4()}.mp3`);
                
                console.log(`Downloading random background music: ${randomKey}`);
                const data = await s3.getObject({ 
                    Bucket: S3_BUCKET, 
                    Key: randomKey 
                }).promise();
                fs.writeFileSync(localPath, data.Body);
                console.log('Random background music downloaded:', path.basename(randomKey));
                return localPath;
            } else {
                console.warn('No audio files found in S3 bucket');
                return null;
            }
        } catch (err) {
            console.warn('Failed to fetch random background music from S3:', err.message);
            return null;
        }
    }
}

async function uploadVideoToS3(localPath, jobId) {
    const s3 = new AWS.S3();
    const fileStream = fs.createReadStream(localPath);
    const uploadParams = {
        Bucket: S3_BUCKET,
        Key: `${S3_VIDEO_PREFIX}${jobId}.mp4`,
        Body: fileStream,
        ContentType: 'video/mp4',
    };

    try {
        console.log('Uploading video to S3...');
        const result = await s3.upload(uploadParams).promise();
        console.log('Video uploaded to S3:', result.Location);
        return result.Location;
    } catch (err) {
        console.error('Failed to upload video to S3:', err);
        throw err;
    }
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

/* ============================
   ROUTES
============================ */

router.post('/ai-video/script', upload.none(), async (req, res) => {
    const {
        campaignTitle,
        campaignDescription,
        scriptContext,
        voice = 'Ava',
        tone = 'Friendly',
        accountId
    } = req.body;

    if (!campaignDescription && !scriptContext) {
        return res.status(400).json({ error: 'Provide campaignDescription or scriptContext' });
    }

    if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
    }

    const pool = req.app.locals.db;
    
    if (!pool) {
        return res.status(500).json({ 
            error: 'Database connection not available.',
            details: 'Database pool not found in app.locals'
        });
    }

    try {
        const scriptResponse = await requestScriptFromOpenAI({
            apiKey: req.openai_api_key || process.env.OPENAI_API_KEY,
            campaignTitle,
            campaignDescription,
            scriptContext,
            voice,
            tone,
            accountId,
            pool: pool
        });

        res.json({
            script: scriptResponse.script,
            talkingPoints: scriptResponse.talkingPoints,
            voice,
            tone,
            title: scriptResponse.title,
            description: scriptResponse.description,
            tokensUsed: scriptResponse.tokensUsed,
            walletUnitsDeducted: scriptResponse.walletUnitsDeducted,
            remainingWalletUnits: scriptResponse.remainingWalletUnits
        });
    } catch (err) {
        console.error('AI video script error:', err);
        res.status(500).json({ error: 'Failed to generate script', details: err.message });
    }
});

router.post('/ai-video/generate-video', upload.none(), async (req, res) => {
    // 1. CAPTURE & VALIDATE INPUT
    const rawInputScript = req.body.script;
    const accountId = req.body.accountId;
    const { voice = 'Ava', tone = 'Friendly', media, backgroundMusic } = req.body;

    // Strict Error Handling: If no script is provided, stop immediately.
    if (!rawInputScript || typeof rawInputScript !== 'string' || rawInputScript.trim().length < 10) {
        return res.status(400).json({ 
            error: 'Missing or Invalid Script', 
            details: 'The script field is empty or too short. You must provide a brand story.' 
        });
    }

    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const pool = req.app.locals.db;
    let localMediaPaths = [];
    let audioPath = null;
    let bgMusicPath = null;

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // 2. BREAKDOWN THE SCRIPT (The World-Class Ad Structure)
        // We set temperature to 0 to stop the AI from "inventing" ABC Solutions.
        const segmentResponse = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { 
                    role: 'system', 
                    content: 'You are a robotic text segmenter. Use ONLY the provided text. NEVER use generic templates like ABC Solutions or Ava Solutions.' 
                },
                { 
                    role: 'user', 
                    content: `Break this specific script into 4 segments (hook, problem, solution, cta): "${rawInputScript}"` 
                }
            ],
            response_format: { type: "json_object" },
            temperature: 0 
        });

        const structuredScript = JSON.parse(segmentResponse.choices[0].message.content);

        // 3. PROCESS MEDIA FILES
        let mediaFiles = [];
        try {
            mediaFiles = typeof media === 'string' ? JSON.parse(media) : (media || []);
        } catch (e) { mediaFiles = []; }

        for (const item of mediaFiles) {
            const path = await downloadFileIfNeeded(item.filePath);
            localMediaPaths.push(path);
        }

        // If no user media, download one relevant Pexels video as a base
        if (localMediaPaths.length === 0) {
            const pexelsPath = await downloadPexelsVideo({
                apiKey: process.env.PEXELS_API_KEY,
                scriptTitle: structuredScript.title,
                scriptText: rawInputScript
            });
            localMediaPaths.push(pexelsPath);
        }

        // 4. GENERATE VOICE OVER & ASSEMBLE AUDIO
        const fullAdText = structuredScript.segments.map(s => s.text).join(' ');
        audioPath = await synthesizeVoiceOver({ 
            script: fullAdText, 
            voice, 
            tone, 
            apiKey: process.env.OPENAI_API_KEY 
        });
        
        const totalDuration = await getMediaDuration(audioPath);
        bgMusicPath = await downloadBackgroundMusicFromS3(backgroundMusic);

        // 5. VIDEO ASSEMBLY (Using your existing createVideoWithTransitions)
        const finalVideoLocalPath = path.join(TEMP_DIR, `final_ad_${uuidv4()}.mp4`);
        await createVideoWithTransitions(
            localMediaPaths, 
            finalVideoLocalPath, 
            totalDuration, 
            audioPath, 
            bgMusicPath
        );

        // 6. UPLOAD TO S3
        const jobId = uuidv4();
        const videoUrl = await uploadVideoToS3(finalVideoLocalPath, jobId);

        // 7. FINAL RESPONSE
        res.json({
            jobId: jobId,
            videoUrl: videoUrl,
            downloadUrl: videoUrl,
            expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
            voice,
            tone,
            category: "brand_story",
            script: structuredScript, // Now contains Happy Coffee
            duration: totalDuration,
            walletUnitsDeducted: VIDEO_GENERATION_COST,
            videoSource: mediaFiles.length > 0 ? "user" : "pexels",
            outputLocation: {
                bucket: S3_BUCKET,
                prefix: S3_VIDEO_PREFIX
            }
        });

        // Background Cleanup
        safeUnlink(finalVideoLocalPath);

    } catch (err) {
        console.error('CRITICAL VIDEO GEN ERROR:', err);
        res.status(500).json({ error: 'Failed to generate video', details: err.message });
    } finally {
        // Ensure cleanup of all temporary files
        if (audioPath) safeUnlink(audioPath);
        if (bgMusicPath) safeUnlink(bgMusicPath);
        localMediaPaths.forEach(p => safeUnlink(p));
    }
});

module.exports = router;
// router.get('/ai-video/jobs/:jobId', (req, res) => {
//     const job = getActiveJob(req.params.jobId);
//     if (!job) return res.status(404).json({ error: 'Job not found or expired' });

//     res.json({
//         jobId: job.id,
//         filename: job.filename,
//         videoUrl: job.path,
//         downloadUrl: job.path,
//         expiresAt: new Date(job.expiresAt).toISOString(),
//         voice: job.voice,
//         tone: job.tone,
//         script: job.script,
//         duration: job.duration
//     });
// });

// router.delete('/ai-video/jobs/:jobId', (req, res) => {
//     const job = videoJobs.get(req.params.jobId);
//     if (!job) return res.status(404).json({ error: 'Job not found' });

//     cleanupJob(req.params.jobId);
//     res.json({ success: true });
// });

// router.get('/ai-video/video/:jobId', (req, res) => {
//     const job = getActiveJob(req.params.jobId);
//     if (!job) return res.status(404).json({ error: 'Video not found or expired' });

//     if (job.path.startsWith('http')) {
//         return res.redirect(job.path);
//     }

//     const mimeType = inferMimeType(job.path);
//     res.setHeader('Content-Type', mimeType);
//     res.setHeader('Content-Disposition', `inline; filename="${job.filename}"`);
//     res.sendFile(path.resolve(job.path), (err) => {
//         if (err) {
//             console.error('Error streaming AI video:', err);
//             if (!res.headersSent) res.status(500).json({ error: 'Failed to stream media file' });
//         }
//     });
// });

// module.exports = router;