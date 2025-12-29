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

// Resolve ffmpeg binary dynamically (env -> ffmpeg-static -> PATH)
let resolvedFfmpeg = process.env.FFMPEG_PATH;
if (!resolvedFfmpeg) {
    try { resolvedFfmpeg = require('ffmpeg-static'); } catch (_) { /* optional */ }
}
if (!resolvedFfmpeg || (path.isAbsolute(resolvedFfmpeg) && !fs.existsSync(resolvedFfmpeg))) {
    resolvedFfmpeg = 'ffmpeg';
}
ffmpeg.setFfmpegPath(resolvedFfmpeg);

// Resolve ffprobe path so duration checks work even when using ffmpeg-static
let resolvedFfprobe = process.env.FFPROBE_PATH;
if (!resolvedFfprobe) {
    try { resolvedFfprobe = require('ffprobe-static')?.path; } catch (_) { /* optional */ }
}
if (!resolvedFfprobe || (path.isAbsolute(resolvedFfprobe) && !fs.existsSync(resolvedFfprobe))) {
    resolvedFfprobe = 'ffprobe';
}
ffmpeg.setFfprobePath(resolvedFfprobe);

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Use /tmp in Lambda, local temp directory otherwise
const TEMP_DIR = process.env.AWS_EXECUTION_ENV ? '/tmp' : path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const videoJobs = new Map();
const upload = multer();

// S3 Configuration
const S3_BUCKET = 'iendorse-audio-assets';
const S3_AUDIO_PREFIX = 'background-music/';
const S3_VIDEO_PREFIX = 'ai-generated-videos/';

// Map UI voice labels to OpenAI TTS voices
const OPENAI_TTS_VOICE_MAP = {
    Ava: 'alloy',
    Noah: 'verse',
    Sofia: 'shimmer',
    Mason: 'onyx'
};





// Route to generate voice sample
// router.post('/ai-video/voice-sample', async (req, res) => {
//     const { voice = 'alloy' } = req.body;

//     // OpenAI TTS available voices: alloy, echo, fable, onyx, nova, shimmer
//     const voiceMap = {
//     Ava: 'alloy',
//     Noah: 'echo',
//     Sofia: 'shimmer',
//     Mason: 'onyx'
//     };

//    // const openaiVoice = voiceMap[voice] || voiceMap['default'];
   
//     const openaiVoice = voiceMap[voice] || voiceMap.Ava || 'alloy';



//     try {
//         const openai = new OpenAI({
//             apiKey: req.openai_api_key || process.env.OPENAI_API_KEY
//         });

//         console.log(`Generating voice sample for ${voice} (${openaiVoice})`);

//         // Generate speech
//         const mp3 = await openai.audio.speech.create({
//             model: "tts-1", // or "tts-1-hd" for higher quality
//             voice: openaiVoice,
//             input: `Hello! This is ${voice} speaking. I'm here to help you create amazing content.`,
//         });

//         // Convert to buffer
//         const buffer = Buffer.from(await mp3.arrayBuffer());

//         // Set response headers for audio
//         res.set({
//             'Content-Type': 'audio/mpeg',
//             'Content-Length': buffer.length,
//             'Content-Disposition': `inline; filename="voice-sample-${voice}.mp3"`
//         });

//         // Send the audio buffer
//         res.send(buffer);

//     } catch (error) {
//         console.error('Error generating voice sample:', error);
//         res.status(500).json({ 
//             error: 'Failed to generate voice sample',
//             details: error.message 
//         });
//     }
// });




router.post('/ai-video/voice-sample', async (req, res) => {
  const { voice = 'alloy' } = req.body;

  // UI labels -> OpenAI voice ids
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
    // Only cleanup local files, not S3 URLs
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

// Clean up any orphaned temp files on startup
function cleanupOrphanedTempFiles() {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        
        const files = fs.readdirSync(TEMP_DIR);
        const oneHourAgo = Date.now() - JOB_TTL_MS;
        
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                
                // Delete files older than 1 hour
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

// Run cleanup on module load
cleanupOrphanedTempFiles();

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
  const hasBackgroundMusic =
    backgroundMusicPath && fs.existsSync(backgroundMusicPath);

  // MAXIMUM 10 seconds per clip
  const MAX_CLIP_DURATION = 10;
  const durPerMedia = Math.min(
    MAX_CLIP_DURATION,
    totalDuration / imagePaths.length
  );

  // Duration of one full pass of all media (1..N)
  const singlePassDuration = durPerMedia * imagePaths.length;

  // How many times we need to repeat the sequence to fill the audio
  const loopsNeeded = Math.max(
    1,
    Math.ceil(totalDuration / singlePassDuration)
  );

  console.log(
    `Creating video: ${imagePaths.length} media items, ` +
      `${durPerMedia.toFixed(2)}s each, ${loopsNeeded} loop(s), total: ${totalDuration}s`
  );

  // ---------- SINGLE MEDIA CASE ----------
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

        const videoStream = metadata.streams?.find(
          (s) => s.codec_type === 'video'
        );
        videoDuration = parseFloat(metadata.format?.duration || 0) || 0;
        isVideo = !!(videoStream && videoDuration > 0);
      } catch (err) {
        isVideo = false;
        videoDuration = 0;
      }
    }

    if (!isVideo) {
      // Image (or unknown) – treat as still, loop for full duration
      cmd.inputOptions(['-loop', '1', '-t', totalDuration.toString()]);
    } else {
      // Real video
      if (videoDuration < totalDuration - 0.1) {
        let loops = Math.ceil(totalDuration / videoDuration);
        const MAX_VIDEO_LOOPS = 10;
        if (loops > MAX_VIDEO_LOOPS) loops = MAX_VIDEO_LOOPS;
        console.log(
          `Single media: looping video ${loops} times to fill ~${totalDuration}s`
        );
        cmd.inputOptions(['-stream_loop', (loops - 1).toString()]);
      } else {
        console.log(
          `Single media: trimming video from ${videoDuration}s to ${totalDuration}s`
        );
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
      '-t',
      totalDuration.toString(),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-threads',
      '0',
    ];

    if (hasAudio && hasBackgroundMusic) {
      // video = input 0, voice = 1:a, bg = 2:a
      const audioFilter =
        '[1:a]volume=1.0[voice];' +
        '[2:a]volume=0.15,aloop=loop=-1:size=2e+09[bg];' +
        '[voice][bg]amix=inputs=2:duration=shortest[aout]';
      outputOpts.push(
        '-filter_complex',
        audioFilter,
        '-map',
        '0:v',
        '-map',
        '[aout]',
        '-c:a',
        'aac',
        '-b:a',
        '128k'
      );
    } else if (hasAudio) {
      outputOpts.push(
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
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

  // ---------- MULTIPLE MEDIA CASE ----------
  const transitionDuration = 2.5;
  const processedClips = [];

  try {
    // 1) Turn each media into a clip of exactly durPerMedia seconds
    for (let i = 0; i < imagePaths.length; i++) {
      const mediaPath = imagePaths[i];
      const clipPath = path.join(
        TEMP_DIR,
        `processed_${i}_${uuidv4()}.mp4`
      );

      const ext = path.extname(mediaPath).toLowerCase();
      const isImageExt = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(
        ext
      );

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

          const videoStream = metadata.streams?.find(
            (s) => s.codec_type === 'video'
          );
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
          // Image (or unknown) – treat as still
          cmd.inputOptions(['-loop', '1', '-t', durPerMedia.toString()]);
        } else {
          // Real video: loop or trim to reach durPerMedia
          if (videoDuration < durPerMedia - 0.1) {
            let loops = Math.ceil(durPerMedia / videoDuration);
            const MAX_VIDEO_LOOPS = 10;
            if (loops > MAX_VIDEO_LOOPS) loops = MAX_VIDEO_LOOPS;
            console.log(
              `  Looping video ${loops} times to fill ~${durPerMedia}s`
            );
            cmd.inputOptions(['-stream_loop', (loops - 1).toString()]);
          } else {
            console.log(
              `  Trimming video from ${videoDuration}s to ${durPerMedia}s`
            );
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
            '-t',
            durPerMedia.toString(), // force exact duration
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '30',
            '-pix_fmt',
            'yuv420p',
            '-an', // drop any source audio
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

    console.log(
      `All media processed. Creating ${loopsNeeded} loop(s) with transitions...`
    );

    // 2) Build the final sequence with loopsNeeded passes of all clips
    const cmd = ffmpeg();

    for (let loop = 0; loop < loopsNeeded; loop++) {
      processedClips.forEach((clip) => cmd.input(clip));
    }

    if (hasAudio) cmd.input(audioPath);
    if (hasBackgroundMusic) cmd.input(backgroundMusicPath);

    // total video inputs = processedClips.length * loopsNeeded
    const totalClips = processedClips.length * loopsNeeded;

    const filterParts = [];

    // label each video input
    for (let i = 0; i < totalClips; i++) {
      filterParts.push(`[${i}:v]null[v${i}]`);
    }

    // xfade chain
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
      '-map',
      '[vout]',
      '-t',
      totalDuration.toString(), // match audio length
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-threads',
      '0',
    ];

    if (hasAudio && hasBackgroundMusic) {
      // voiceover = [totalClips]:a, background = [totalClips+1]:a
      const audioFilter =
        `[${totalClips}:a]volume=1.0[voice];` +
        `[${totalClips + 1}:a]volume=0.15,aloop=loop=-1:size=2e+09[bg];` +
        `[voice][bg]amix=inputs=2:duration=shortest[aout]`;
      filterSegments.push(audioFilter);
      cmd.complexFilter(filterSegments.join(';'));
      outputOpts.push(
        '-map',
        '[aout]',
        '-c:a',
        'aac',
        '-b:a',
        '128k'
      );
    } else if (hasAudio) {
      // no background music – just use voiceover stream directly
      cmd.complexFilter(filterSegments.join(';'));
      outputOpts.push(
        '-map',
        `${totalClips}:a`,
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-shortest'
      );
    } else {
      // no audio at all
      cmd.complexFilter(filterSegments.join(';'));
    }

    cmd.outputOptions(outputOpts).output(outputVideoPath);

    await new Promise((resolve, reject) => {
      cmd
        .on('start', () =>
          console.log('Creating final video with looped clips...')
        )
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

    // cleanup
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

//////////
// Define the cost
const SCRIPT_GENERATION_COST = 20;
const VIDEO_GENERATION_COST = 50;

async function requestScriptFromOpenAI({ apiKey, campaignTitle, campaignDescription, scriptContext, voice, tone, accountId, pool }) {

    // Check for wallet unit availability
    if (!pool) {
        console.error("Database connection not available!");
        throw new Error('Database connection not available.');
    }

    if (!accountId) {
        throw new Error('Account ID is required.');
    }

    // Query to retrieve account wallet information
    const walletQuery = `
        SELECT
            a.Id,
            a.WalletUnits
        FROM
            Accounts AS a
        WHERE
            a.Id = @accountId;
    `;

    console.log("Executing database query with accountId:", accountId);

    // Execute the query with parameterized input
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

    // Check if wallet has sufficient units
    if (account.WalletUnits < SCRIPT_GENERATION_COST) {
        throw new Error(`Insufficient wallet units. You have ${account.WalletUnits} units but need ${SCRIPT_GENERATION_COST} units to generate a script.`);
    }

    console.log(`Wallet unit check passed. Account has sufficient units (required: ${SCRIPT_GENERATION_COST}).`);

    // Generate script with OpenAI
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

    // Deduct units from wallet after successful script generation
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

    // Add the deduction info to the result for the client
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
        // Specific file requested
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
        // Pick random music from S3
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
       // ACL: 'public-read'
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

router.post('/ai-video/script', upload.none(), async (req, res) => {
    const {
        campaignTitle,
        campaignDescription,
        scriptContext,
        voice = 'Ava',
        tone = 'Friendly',
        accountId  // Add accountId from request body
    } = req.body;

    // Validate required fields
    if (!campaignDescription && !scriptContext) {
        return res.status(400).json({ error: 'Provide campaignDescription or scriptContext' });
    }

    if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
    }

    // Get the database pool from app.locals
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
            accountId,      // Pass accountId
            pool: pool      // Pass pool
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
    let { script, voice = 'Ava', tone = 'Friendly', media, backgroundMusic, accountId } = req.body;

    if (!script || typeof script !== 'string') {
        return res.status(400).json({ error: 'Script text is required' });
    }

    if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
    }

    // Get the database pool from app.locals
    const pool = req.app.locals.db;
    
    if (!pool) {
        return res.status(500).json({ 
            error: 'Database connection not available.',
            details: 'Database pool not found in app.locals'
        });
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
    let audioDuration = null;
    let backgroundMusicPath = null;
    let finalVideoPath = null;

    try {
        // ===== CHECK WALLET UNITS BEFORE PROCESSING =====
        const walletQuery = `
            SELECT
                a.Id,
                a.WalletUnits
            FROM
                Accounts AS a
            WHERE
                a.Id = @accountId;
        `;

        console.log("Checking wallet units for accountId:", accountId);

        const result = await pool.request()
            .input('accountId', sql.Int, parseInt(accountId, 10))
            .query(walletQuery);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }

        const account = result.recordset[0];
        console.log("Account found:", account.Id);
        console.log("Wallet units:", account.WalletUnits);

        // Check if wallet has sufficient units
        if (account.WalletUnits < VIDEO_GENERATION_COST) {
            return res.status(400).json({
                error: 'Insufficient wallet units.',
                message: `You have ${account.WalletUnits} units but need ${VIDEO_GENERATION_COST} units to generate a video.`,
                currentWalletUnits: account.WalletUnits,
                requiredUnits: VIDEO_GENERATION_COST
            });
        }

        console.log(`Wallet unit check passed. Account has sufficient units (required: ${VIDEO_GENERATION_COST}).`);
        // ===== END WALLET CHECK =====

        audioPath = await synthesizeVoiceOver({
            script,
            voice,
            tone,
            apiKey: req.openai_api_key || process.env.OPENAI_API_KEY
        });
        audioDuration = await getMediaDuration(audioPath);
        if (!audioDuration || !Number.isFinite(audioDuration) || audioDuration <= 0) {
            throw new Error('Unable to determine voiceover duration');
        }
        
        // Download background music from S3
        backgroundMusicPath = await downloadBackgroundMusicFromS3(backgroundMusic);
        if (backgroundMusicPath) {
            tempFiles.push(backgroundMusicPath);
        }
        
        const mediaPaths = [];

        // Download all media files
        for (let i = 0; i < media.length; i++) {
            const mediaItem = media[i];
            if (!mediaItem?.filePath) continue;

            const localPath = await downloadFileIfNeeded(mediaItem.filePath);
            tempFiles.push(localPath);
            mediaPaths.push(localPath);
        }

        if (!mediaPaths.length) {
            throw new Error('No usable media files were provided');
        }

        // Use voiceover duration as the source of truth for the video length
        const totalDuration = audioDuration;

        finalVideoPath = path.join(TEMP_DIR, `ai_video_${uuidv4()}.mp4`);
        
        await createVideoWithTransitions(mediaPaths, finalVideoPath, totalDuration, audioPath, backgroundMusicPath);

        // Generate job ID
        const jobId = uuidv4();
        
        // Upload video to S3
        const s3VideoUrl = await uploadVideoToS3(finalVideoPath, jobId);
        
        // Clean up the local video file immediately after upload
        safeUnlink(finalVideoPath);
        safeUnlink(audioPath);

        const job = registerJob({
            filePath: s3VideoUrl,
            audioPath: null,
            script,
            voice,
            tone,
            duration: totalDuration
        });

        // ===== DEDUCT WALLET UNITS AFTER SUCCESSFUL VIDEO GENERATION =====
        console.log(`Video generated successfully, now deducting ${VIDEO_GENERATION_COST} wallet units...`);

        const updateQuery = `
            UPDATE Accounts
            SET WalletUnits = WalletUnits - @cost
            WHERE Id = @accountId;
        `;

        await pool.request()
            .input('accountId', sql.Int, parseInt(accountId, 10))
            .input('cost', sql.Int, VIDEO_GENERATION_COST)
            .query(updateQuery);

        const newBalance = account.WalletUnits - VIDEO_GENERATION_COST;
        console.log(`Successfully deducted ${VIDEO_GENERATION_COST} units from account:`, accountId);
        console.log("New wallet balance:", newBalance);
        // ===== END WALLET DEDUCTION =====

        res.json({
            jobId: job.id,
            videoUrl: s3VideoUrl,
            downloadUrl: s3VideoUrl,
            expiresAt: new Date(job.expiresAt).toISOString(),
            voice,
            tone,
            script,
            duration: totalDuration,
            backgroundMusic: backgroundMusic || 'random',
            walletUnitsDeducted: VIDEO_GENERATION_COST,
            remainingWalletUnits: newBalance
        });
    } catch (err) {
        console.error('AI video generation error:', err);
        tempFiles.forEach(safeUnlink);
        safeUnlink(audioPath);
        safeUnlink(finalVideoPath);
        return res.status(500).json({ error: 'Failed to generate AI video', details: err.message });
    } finally {
        // Cleanup downloaded media files
        tempFiles.forEach(safeUnlink);
    }
});

router.get('/ai-video/jobs/:jobId', (req, res) => {
    const job = getActiveJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });

    res.json({
        jobId: job.id,
        filename: job.filename,
        videoUrl: job.path,
        downloadUrl: job.path,
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

    // If it's an S3 URL, redirect to it
    if (job.path.startsWith('http')) {
        return res.redirect(job.path);
    }

    // Fallback for local files (shouldn't happen in Lambda production)
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
