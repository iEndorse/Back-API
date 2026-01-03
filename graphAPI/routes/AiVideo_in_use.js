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

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
const upload = multer();

/* ============================
   FFmpeg path resolution
============================ */
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

/* ============================
   TEMP
============================ */
const TEMP_DIR = process.env.AWS_EXECUTION_ENV ? '/tmp' : path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/* ============================
   S3 setup
   ✅ Output stays in iendorse-audio-assets (old pipeline)
============================ */
const AUDIO_BUCKET = process.env.AUDIO_BUCKET || 'iendorse-audio-assets';
const S3_AUDIO_PREFIX = process.env.S3_AUDIO_PREFIX || 'background-music/';

// KEEP OLD OUTPUT LOCATION
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || AUDIO_BUCKET;
const S3_VIDEO_PREFIX = process.env.S3_VIDEO_PREFIX || 'ai-generated-videos/';

// Stock library bucket/prefix (moving background videos)
const STOCK_BUCKET = process.env.STOCK_BUCKET || 'iendore-stock-assets';
const STOCK_BASE_PREFIX = (process.env.STOCK_BASE_PREFIX || 'stock').replace(/\/+$/, '');

const s3 = new AWS.S3();

/* ============================
   Costs
============================ */
const SCRIPT_GENERATION_COST = parseInt(process.env.SCRIPT_GENERATION_COST || '2', 10);
const VIDEO_GENERATION_COST = parseInt(process.env.VIDEO_GENERATION_COST || '5', 10);

/* ============================
   Jobs
============================ */
const JOB_TTL_MS = 60 * 60 * 1000;
const videoJobs = new Map();

function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }
function cleanupJob(jobId) {
  const job = videoJobs.get(jobId);
  if (!job) return;
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
function registerJob({ filePath, script, voice, tone, duration }) {
  const jobId = uuidv4();
  const record = {
    id: jobId,
    path: filePath,
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
   Helpers
============================ */
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
function isUrl(p) { return typeof p === 'string' && /^https?:\/\//i.test(p); }

function isVideoPath(p) { return /\.(mp4|mov|mkv|avi|webm)$/i.test(String(p || '')); }
function isImagePath(p) { return /\.(jpg|jpeg|png|webp)$/i.test(String(p || '')); }

function normalizeCategory(cat) {
  const c = String(cat || 'business')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return c || 'business';
}


function normalizeIntent(intent) {
  const i = String(intent || '').toLowerCase();
  if (i.includes('hook') || i.includes('attention')) return 'hook';
  if (i.includes('problem') || i.includes('pain')) return 'problem';
  if (i.includes('solution') || i.includes('product')) return 'solution';
  if (i.includes('cta') || i.includes('action')) return 'cta';
  return 'general';
}

function enforceIntents(segments) {
  const fallback = ['hook', 'problem', 'solution', 'cta'];
  return (segments || [])
    .map((s, idx) => ({
      ...s,
      intent: normalizeIntent(s?.intent || fallback[idx] || 'general'),
      id: String(s?.id || s?.intent || `seg${idx + 1}`),
      text: String(s?.text || '').trim(),
      onScreenText: String(s?.onScreenText || '').trim(),
    }))
    .filter(s => s.text.length > 0);
}

function getMediaDuration(mediaPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(mediaPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(parseFloat(metadata?.format?.duration) || 0);
    });
  });
}

async function downloadFileIfNeeded(filePath) {
  if (!filePath) throw new Error('Media filePath is required');
  const ext = path.extname(filePath).toLowerCase() || '.bin';
  const out = path.join(TEMP_DIR, `${uuidv4()}${ext}`);

  if (isUrl(filePath)) {
    const response = await axios({ method: 'get', url: filePath, responseType: 'stream', timeout: 45000 });
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(out);
      response.data.pipe(w);
      w.on('finish', resolve);
      w.on('error', reject);
    });
    return out;
  }

  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  fs.copyFileSync(filePath, out);
  return out;
}

/* ============================
   DB pool
============================ */
function getDbPoolFromReq(req) {
  const pool = req?.app?.locals?.db;
  if (!pool || !pool.connected) throw new Error('Database pool not available');
  return pool;
}

async function deductWalletUnitsAtomic({ pool, accountId, cost }) {
  const q = `
    UPDATE Accounts
    SET WalletUnits = WalletUnits - @cost
    WHERE Id = @accountId AND WalletUnits >= @cost;

    SELECT @@ROWCOUNT AS rowsAffected;

    SELECT Id, WalletUnits
    FROM Accounts
    WHERE Id = @accountId;
  `;

  const r = await pool.request()
    .input('accountId', sql.Int, parseInt(accountId, 10))
    .input('cost', sql.Int, cost)
    .query(q);

  const rowsAffected = r.recordsets?.[0]?.[0]?.rowsAffected || 0;
  const account = r.recordsets?.[1]?.[0];

  if (!account) throw new Error('Account not found.');
  if (rowsAffected === 0) throw new Error(`Insufficient wallet units. You have ${account.WalletUnits} but need ${cost}.`);
  return { remainingWalletUnits: account.WalletUnits };
}

/* ============================
   Voice mapping
============================ */
const ALLOWED_TTS_VOICES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
const OPENAI_TTS_VOICE_MAP = { Ava: 'alloy', Noah: 'echo', Sofia: 'shimmer', Mason: 'onyx' };

function resolveTtsVoice(voiceLabelOrId) {
  if (ALLOWED_TTS_VOICES.has(voiceLabelOrId)) return voiceLabelOrId;
  return OPENAI_TTS_VOICE_MAP[voiceLabelOrId] || 'alloy';
}

/* ============================
   ✅ Tone -> TTS instructions (NOT spoken)
============================ */
function toneToInstructions(tone) {
  const t = String(tone || '').toLowerCase().trim();
  switch (t) {
    case 'friendly':
      return 'Warm, friendly, and welcoming. Natural pace.';
    case 'excited':
      return 'Upbeat, energetic, enthusiastic. Slightly faster pace.';
    case 'urgent':
      return 'Urgent, persuasive, faster pace, strong emphasis.';
    case 'professional':
      return 'Clear, confident, professional. Calm and steady.';
    default:
      return '';
  }
}

/* ============================
   Background music
============================ */
async function downloadBackgroundMusicFromS3(backgroundMusic) {
  if (backgroundMusic) {
    const key = `${S3_AUDIO_PREFIX}${backgroundMusic}`;
    const localPath = path.join(TEMP_DIR, `bg_${uuidv4()}.mp3`);
    try {
      const data = await s3.getObject({ Bucket: AUDIO_BUCKET, Key: key }).promise();
      fs.writeFileSync(localPath, data.Body);
      return localPath;
    } catch (_) {
      return null;
    }
  }

  try {
    const listParams = { Bucket: AUDIO_BUCKET, Prefix: S3_AUDIO_PREFIX, MaxKeys: 500 };
    const s3Files = await s3.listObjectsV2(listParams).promise();
    const audioFiles = (s3Files.Contents || [])
      .map(obj => obj.Key)
      .filter(key => key && key.toLowerCase().match(/\.(mp3|wav|m4a|aac)$/));

    if (!audioFiles.length) return null;

    const randomKey = audioFiles[Math.floor(Math.random() * audioFiles.length)];
    const localPath = path.join(TEMP_DIR, `bg_${uuidv4()}.mp3`);
    const data = await s3.getObject({ Bucket: AUDIO_BUCKET, Key: randomKey }).promise();
    fs.writeFileSync(localPath, data.Body);
    return localPath;
  } catch (_) {
    return null;
  }
}

/* ============================
   Stock selection (VIDEO ONLY)
============================ */
function buildStockPrefixes({ category, intent }) {
  const cat = normalizeCategory(category);
  const it = normalizeIntent(intent);
  const base = STOCK_BASE_PREFIX;
  return [
    `${base}/video/${cat}/${it}/`,
    `${base}/video/${cat}/general/`,
    `${base}/video/general/${it}/`,
    `${base}/video/general/general/`,
  ];
}

const prefixCache = new Map();
const PREFIX_CACHE_TTL_MS = 15 * 60 * 1000;

async function listKeysCached(prefix) {
  const now = Date.now();
  const cached = prefixCache.get(prefix);
  if (cached && now < cached.expiresAt) return cached.keys;

  const r = await s3.listObjectsV2({
    Bucket: STOCK_BUCKET,
    Prefix: prefix,
    MaxKeys: 500
  }).promise();

  const keys = (r.Contents || [])
    .map(x => x.Key)
    .filter(k => k && !k.endsWith('/'))
    .filter(k => isVideoPath(k));

  prefixCache.set(prefix, { keys, expiresAt: now + PREFIX_CACHE_TTL_MS });
  return keys;
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function downloadS3KeyToLocal(bucket, key) {
  const out = path.join(TEMP_DIR, `s3_${uuidv4()}_${path.basename(key)}`);
  const obj = await s3.getObject({ Bucket: bucket, Key: key }).promise();
  fs.writeFileSync(out, obj.Body);
  return out;
}

async function pickStockVideoLocalPath({ category, intent }) {
  const prefixes = buildStockPrefixes({ category, intent });
  for (const prefix of prefixes) {
    const keys = await listKeysCached(prefix);
    if (keys.length) return await downloadS3KeyToLocal(STOCK_BUCKET, pickRandom(keys));
  }
  return null;
}

/* ============================
   Segmented script generator
============================ */
function buildSegmentedScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone, category }) {
  return `
You are a campaign copywriter for small and medium business owners.

Return JSON ONLY:
{
  "title": "5-10 word title INCLUDING the company name",
  "description": "1-2 sentence summary (<= 200 chars)",
  "segments": [
    { "id": "hook", "intent": "hook", "text": "2-3 sentence"},
    { "id": "problem", "intent": "problem", "text": "2-3 sentences"},
    { "id": "solution", "intent": "solution", "text": "2-3 sentences"},
    { "id": "cta", "intent": "cta", "text": "2-3 short sentence"}
  ]
}

Tone: ${tone || 'friendly'}
Voice Talent: ${voice || 'default'}
Category: ${category || 'general'}

Campaign Title: ${campaignTitle || 'Untitled Campaign'}
Campaign Description: ${campaignDescription || 'N/A'}
Additional Context: ${scriptContext || 'N/A'}
`;
}

async function generateSegmentedScript({ apiKey, payload }) {
  const openai = new OpenAI({ apiKey });

  const r = await openai.chat.completions.create({
    model: process.env.SCRIPT_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Return JSON only. No markdown. No commentary.' },
      { role: 'user', content: buildSegmentedScriptPrompt(payload) },
    ],
    temperature: 0.7,
  });

  const content = r.choices?.[0]?.message?.content || '{}';
  const json = safeJsonParse(content);
  if (!json) throw new Error('Model did not return valid JSON for script.');

  const segments = enforceIntents(json.segments);
  if (!segments.length) throw new Error('No usable segments returned.');

  return {
    title: String(json.title || '').trim(),
    description: String(json.description || '').trim(),
    segments,
  };
}

/* ============================
   TTS per segment + concat
============================ */
async function synthesizeSegmentAudio({ apiKey, ttsVoice, segmentText, tone }) {
  const openai = new OpenAI({ apiKey });
  const audioPath = path.join(TEMP_DIR, `seg_${uuidv4()}.mp3`);

  const response = await openai.audio.speech.create({
    model: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
    voice: ttsVoice,
    input: String(segmentText || '').trim(),
    instructions: toneToInstructions(tone),
    response_format: 'mp3',
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(audioPath, buffer);
  return audioPath;
}

async function concatAudioMp3({ segmentAudioPaths, outPath }) {
  const listPath = path.join(TEMP_DIR, `concat_${uuidv4()}.txt`);
  fs.writeFileSync(listPath, segmentAudioPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c:a', 'mp3', '-q:a', '4'])
      .output(outPath)
      .on('end', resolve)
      .on('error', (err, _stdout, stderr) => reject(new Error(stderr || err.message)))
      .run();
  });

  safeUnlink(listPath);
  return outPath;
}

async function synthesizeVoiceOverBySegments({ segments, voice, tone, apiKey }) {
  const ttsVoice = resolveTtsVoice(voice);

  const segmentAudioPaths = [];
  for (const s of segments) {
    segmentAudioPaths.push(await synthesizeSegmentAudio({
      apiKey,
      ttsVoice,
      segmentText: s.text,
      tone,
    }));
  }

  const mergedAudioPath = path.join(TEMP_DIR, `voice_${uuidv4()}.mp3`);
  await concatAudioMp3({ segmentAudioPaths, outPath: mergedAudioPath });

  const segmentDurations = [];
  for (const p of segmentAudioPaths) segmentDurations.push(await getMediaDuration(p));

  return { mergedAudioPath, segmentAudioPaths, segmentDurations };
}

/* ============================
   Subtitles (SRT)
============================ */
function formatSrtTime(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.floor((s - Math.floor(s)) * 1000)).padStart(3, '0');
  return `${hh}:${mm}:${ss},${ms}`;
}

function buildSrtFromSegments({ segments, segmentDurations }) {
  let t = 0;
  let idx = 1;
  const lines = [];

  for (let i = 0; i < segments.length; i++) {
    const start = t;
    const end = t + (segmentDurations[i] || 0);
    t = end;

    const text = String(segments[i].text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    lines.push(String(idx++));
    lines.push(`${formatSrtTime(start)} --> ${formatSrtTime(end)}`);
    lines.push(text);
    lines.push('');
  }
  return { srt: lines.join('\n'), totalDuration: t };
}

/* ============================
   SMART PHOTO OVERLAY PLANNING
   - respects media order (drag/drop)
   - forces first photo into hook, last photo into cta
   - distributes remaining photos across middle segments
============================ */
function distributePhotosToSegments({ segments, photos }) {
  if (!photos.length) return segments.map(() => []);

  const n = segments.length;

  // default buckets
  const buckets = Array.from({ length: n }, () => []);

  // force first and last photos if we have >=2 photos
  const first = photos[0];
  const last = photos.length > 1 ? photos[photos.length - 1] : null;

  buckets[0].push(first);
  if (last && last !== first) buckets[n - 1].push(last);

  const middle = photos.slice(1, last ? -1 : 1);

  // distribute middle photos round-robin starting at segment 1 (problem) to segment n-2 (solution)
  if (middle.length) {
    let idx = 1;
    const endIdx = Math.max(1, n - 2);
    for (const p of middle) {
      buckets[idx].push(p);
      idx++;
      if (idx > endIdx) idx = 1;
    }
  }

  // cap overlays per segment to avoid clutter: 2 max per segment (except solution can take 3)
  for (let i = 0; i < buckets.length; i++) {
    const cap = (segments[i]?.intent === 'solution') ? 3 : 2;
    buckets[i] = buckets[i].slice(0, cap);
  }

  return buckets;
}

/* ============================
   Render plan:
   - backgroundVideo per segment:
      use user videos sequentially (if present)
      else use stock by category+intent
   - overlayPhotos per segment:
      derived from user photos order
============================ */
function assignUserVideosSequential(segments, userVideos) {
  const plan = [];
  let vidIdx = 0;
  for (const seg of segments) {
    const picked = userVideos[vidIdx] || null;
    if (picked) vidIdx++;
    plan.push({
      intent: normalizeIntent(seg.intent),
      onScreenText: seg.onScreenText || '',
      backgroundVideo: picked,     // may be null; stock will fill
      overlayPhotos: [],           // filled later
    });
  }
  return plan;
}

async function fillBackgroundWithStock({ plan, category }) {
  for (const item of plan) {
    if (item.backgroundVideo) continue;
    item.backgroundVideo = await pickStockVideoLocalPath({ category, intent: item.intent });
  }
  return plan;
}

/* ============================
   FFmpeg: segment clip with moving background + photo overlays
   - background: loop stock video to segment duration
   - overlay photos: each with fade in/out + gentle zoom (kenburns)
   - add onScreenText via drawtext safely
============================ */
function escapeForDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}

async function createSegmentClip({
  bgVideoPath,
  overlayPhotoPaths,   // keep name for compatibility (these become spotlight full-screen moments)
  durationSec,
  outPath
}) {
  if (!bgVideoPath || !fs.existsSync(bgVideoPath)) {
    throw new Error('Missing bg video for segment.');
  }

  const dur = Math.max(0.8, Number(durationSec || 0.8));
  const photos = Array.isArray(overlayPhotoPaths) ? overlayPhotoPaths.filter(p => p && fs.existsSync(p)) : [];
  const numPhotos = photos.length;

  const cmd = ffmpeg()
    .input(bgVideoPath)
    // loop bg enough so trim works even if bg is short
    .inputOptions(['-stream_loop', '10']);

  // add photo inputs (loop as video)
  for (const p of photos) {
    cmd.input(p).inputOptions(['-loop', '1']);
  }

  const filters = [];

  // 1) Base background full-screen 9:16 (crop-to-fill, not pad)
  //    - avoids “Padded dimensions cannot be smaller than input dimensions.”
  filters.push(
    `[0:v]` +
    `scale=1080:1920:force_original_aspect_ratio=increase,` +
    `crop=1080:1920,` +
    `setsar=1,fps=30,format=yuv420p,trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[base]`
  );

  let lastLabel = 'base';

  // 2) Spotlight photos full-screen with motion + fades (they REPLACE the screen briefly)
  //    We overlay them full-frame with alpha fade, enabled in time windows.
if (numPhotos > 0) {
  // 1️⃣ Decide how many photos this segment should show
  let maxSpotlights = Math.min(numPhotos, 2);

  // 🔥 NEW: if segment is short, show only ONE photo so it stays longer
  if (dur < 3.8 && maxSpotlights === 2) {
    maxSpotlights = 1;
  }

  const picked = photos.slice(0, maxSpotlights);

  // 2️⃣ Allocate more time to photos (product-forward)
  const PHOTO_MIN_SEC = Number(process.env.PHOTO_MIN_SEC || 5);
  const PHOTO_MAX_SEGMENT_SHARE = Number(process.env.PHOTO_MAX_SHARE || 0.98);
  const PHOTO_LEADIN_SEC = Number(process.env.PHOTO_LEADIN_SEC || 3);

  const spotlightTotal = Math.min(
    dur * PHOTO_MAX_SEGMENT_SHARE,
    Math.max(PHOTO_MIN_SEC * maxSpotlights, PHOTO_MIN_SEC)
  );

  const slot = spotlightTotal / maxSpotlights;

  // 3️⃣ Show photo earlier (less waiting on background)
  const startOffset = Math.min(PHOTO_LEADIN_SEC, dur * 0.10);

    

    for (let i = 0; i < maxSpotlights; i++) {
      const inputIndex = i + 1; // photos start at input 1
      const st = Math.min(dur - 0.2, startOffset + i * slot);
      const en = Math.min(dur, st + slot);

      const fadeIn = Math.min(0.25, (en - st) * 0.25);
      const fadeOut = Math.min(0.25, (en - st) * 0.25);

      // Ken Burns using zoompan. We:
      // - scale image big enough
      // - zoom slowly
      // - output exactly 1080x1920 @ 30fps
      // Note: zoompan works great for stills; it will generate frames.
      const frames = Math.max(24, Math.round((en - st) * 30));

      filters.push(
        `[${inputIndex}:v]` +
        `scale=2400:-1:force_original_aspect_ratio=increase,` +
        `zoompan=` +
          `z='min(zoom+0.0012,1.12)':` +
          `x='iw/2-(iw/zoom/2)':` +
          `y='ih/2-(ih/zoom/2)':` +
          `d=${frames}:` +
          `s=1080x1920:` +
          `fps=30,` +
        `format=rgba,` +
        `fade=t=in:st=0:d=${fadeIn.toFixed(3)}:alpha=1,` +
        `fade=t=out:st=${Math.max(0, (en - st) - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1[sp${i}]`
      );

      // Overlay spotlight full-screen over the base during its time window.
      // We shift spotlight timeline to match segment timeline with setpts.
      filters.push(
        `[sp${i}]setpts=PTS+${st.toFixed(3)}/TB[sp${i}t]`
      );

      filters.push(
        `[${lastLabel}][sp${i}t]overlay=0:0:enable=between(t\\,${st.toFixed(3)}\\,${en.toFixed(3)})[v${i}]`
      );

      lastLabel = `v${i}`;
    }
  }

  // Always end with vout
  filters.push(`[${lastLabel}]null[vout]`);

  const filtergraph = filters.join(';');

  await new Promise((resolve, reject) => {
    cmd
      .outputOptions([
        '-t', String(dur),
        '-filter_complex', filtergraph,
        '-map', '[vout]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '30',
        '-pix_fmt', 'yuv420p',
        '-an',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', (err, _stdout, stderr) => reject(new Error(stderr || err.message)))
      .run();
  });
}





async function createVideoFromSmartPlan({
  smartPlan,
  segmentDurations,
  outputVideoPath,
  voiceAudioPath,
  backgroundMusicPath = null,
  subtitlesSrtPath = null,
}) {
  if (!smartPlan?.length) throw new Error('Smart plan empty.');
  if (smartPlan.length !== segmentDurations.length) throw new Error('Plan/duration mismatch.');
  if (!voiceAudioPath || !fs.existsSync(voiceAudioPath)) throw new Error('Voice audio missing.');

  const clips = [];
  for (let i = 0; i < smartPlan.length; i++) {
    const seg = smartPlan[i];
    const dur = Math.max(0.8, Number(segmentDurations[i] || 0.8));
    const clipPath = path.join(TEMP_DIR, `segclip_${i}_${uuidv4()}.mp4`);

   await createSegmentClip({
  bgVideoPath: seg.backgroundVideo,
  overlayPhotoPaths: seg.overlayPhotos || [],
  durationSec: dur,
  outPath: clipPath
});

    clips.push(clipPath);
  }

  // Concat video clips
  const concatList = path.join(TEMP_DIR, `vconcat_${uuidv4()}.txt`);
  fs.writeFileSync(concatList, clips.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  const cmd = ffmpeg()
    .input(concatList)
    .inputOptions(['-f', 'concat', '-safe', '0'])
    .input(voiceAudioPath);

  const hasBg = backgroundMusicPath && fs.existsSync(backgroundMusicPath);
  if (hasBg) cmd.input(backgroundMusicPath);

  const subtitleBurnIn = String(process.env.SUBTITLE_BURNIN || 'true').toLowerCase() !== 'false';

  const filters = [];
  let vMap = '0:v';
  let aOut = '1:a';

  if (subtitlesSrtPath && subtitleBurnIn) {
    filters.push(`[0:v]subtitles='${subtitlesSrtPath.replace(/:/g, '\\:').replace(/'/g, "\\'")}'[vsub]`);
    vMap = '[vsub]';
  }

  if (hasBg) {
    filters.push(
      `[1:a]volume=1.0[voice];` +
      `[2:a]volume=0.15,aloop=loop=-1:size=2e+09[bg];` +
      `[voice][bg]amix=inputs=2:duration=shortest[aout]`
    );
    aOut = '[aout]';
  }

  if (filters.length) cmd.complexFilter(filters.join(';'));

  await new Promise((resolve, reject) => {
    cmd.outputOptions([
      '-map', vMap,
      '-map', aOut,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '30',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
    ])
      .output(outputVideoPath)
      .on('end', resolve)
      .on('error', (err, _stdout, stderr) => reject(new Error(stderr || err.message)))
      .run();
  });

  safeUnlink(concatList);
  clips.forEach(safeUnlink);
}

/* ============================
   Upload output to S3 (OLD LOCATION)
============================ */
async function uploadVideoToS3(localPath, jobId) {
  const result = await s3.upload({
    Bucket: OUTPUT_BUCKET,
    Key: `${S3_VIDEO_PREFIX}${jobId}.mp4`,
    Body: fs.createReadStream(localPath),
    ContentType: 'video/mp4',
  }).promise();
  return result.Location;
}

async function uploadTextToS3(text, jobId) {
  const result = await s3.upload({
    Bucket: OUTPUT_BUCKET,
    Key: `${S3_VIDEO_PREFIX}${jobId}.srt`,
    Body: Buffer.from(text, 'utf-8'),
    ContentType: 'application/x-subrip',
  }).promise();
  return result.Location;
}

/* ============================
   ROUTES
============================ */

// script
router.post('/ai-video/script', upload.none(), async (req, res) => {
  const {
    campaignTitle,
    campaignDescription,
    scriptContext,
    category,          // ✅ accept category (optional)
    voice = 'Ava',
    tone = 'friendly',
    accountId
  } = req.body;

  if (!accountId) {
    return res.status(400).json({ error: 'accountId is required' });
  }

  const categorySlug = normalizeCategory(category);

  const apiKey = req.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OpenAI key not configured' });
  }

  try {
    const scriptObj = await generateSegmentedScript({
      apiKey,
      payload: {
        campaignTitle,
        campaignDescription,
        scriptContext,
        category: categorySlug,   // ✅ FIXED
        voice,
        tone
      }
    });

    const pool = getDbPoolFromReq(req);
    const { remainingWalletUnits } = await deductWalletUnitsAtomic({
      pool,
      accountId,
      cost: SCRIPT_GENERATION_COST
    });

    return res.json({
      ...scriptObj,
      category: categorySlug,
      voice,
      tone,
      walletUnitsDeducted: SCRIPT_GENERATION_COST,
      remainingWalletUnits
    });

  } catch (err) {
    return res.status(500).json({
      error: 'Failed to generate script',
      details: err.message
    });
  }
});

// generate-video (SMART: moving stock background + user photos overlaid)
router.post('/ai-video/generate-video', upload.none(), async (req, res) => {
 

  let {
    category,
    voice = 'Ava',
    tone = 'friendly',
    campaignTitle,
    campaignDescription,
    scriptContext,

    segments,               // optional: JSON string or array
    media,                  // optional: JSON string or array: [{filePath}]
    backgroundMusic,        // optional filename
    subtitles = false,
    accountId
  } = req.body;
const categorySlug = normalizeCategory(category);

 // if (!category) return res.status(400).json({ error: 'category is required' });
  if (!accountId) return res.status(400).json({ error: 'accountId is required' });

  if (typeof media === 'string') {
    try { media = JSON.parse(media); } catch { return res.status(400).json({ error: 'media must be valid JSON array' }); }
  }
  if (media && !Array.isArray(media)) return res.status(400).json({ error: 'media must be an array of {filePath}' });

  if (typeof segments === 'string') {
    try { segments = JSON.parse(segments); } catch { return res.status(400).json({ error: 'segments must be valid JSON array' }); }
  }

  const apiKey = req.openai_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OpenAI key not configured' });

  const tempFiles = [];
  let bgMusicPath = null;
  let finalVideoPath = null;
  let srtLocalPath = null;

  try {
    const pool = getDbPoolFromReq(req);

    // Wallet check
    const walletRow = await pool.request()
      .input('accountId', sql.Int, parseInt(accountId, 10))
      .query(`SELECT Id, WalletUnits FROM Accounts WHERE Id = @accountId;`);

    if (!walletRow.recordset?.length) return res.status(404).json({ error: 'Account not found.' });
    const currentUnits = walletRow.recordset[0].WalletUnits;

    if (currentUnits < VIDEO_GENERATION_COST) {
      return res.status(400).json({
        error: 'Insufficient wallet units.',
        message: `You have ${currentUnits} units but need ${VIDEO_GENERATION_COST} units to generate a video.`,
        currentWalletUnits: currentUnits,
        requiredUnits: VIDEO_GENERATION_COST
      });
    }

    // 1) Script segments
    let scriptObj;
    if (Array.isArray(segments) && segments.length) {
      scriptObj = {
        title: String(campaignTitle || '').trim(),
        description: '',
        segments: enforceIntents(segments),
      };
    } else {
      scriptObj = await generateSegmentedScript({
        apiKey,
        payload: {
  campaignTitle,
  campaignDescription,
  scriptContext,
  category: categorySlug,
  voice,
  tone
}

      });
    }
    if (!scriptObj.segments?.length) throw new Error('No script segments available.');

    // 2) Download user media in drag order
    const userVideos = [];
    const userPhotos = [];

    const mediaArr = Array.isArray(media) ? media : [];
    for (const m of mediaArr) {
      if (!m?.filePath) continue;
      const local = await downloadFileIfNeeded(m.filePath);
      tempFiles.push(local);

      if (isVideoPath(local)) userVideos.push(local);
      if (isImagePath(local)) userPhotos.push(local);
    }

    // 3) Voiceover by segments
    const { mergedAudioPath, segmentAudioPaths, segmentDurations } =
      await synthesizeVoiceOverBySegments({ segments: scriptObj.segments, voice, tone, apiKey });

    tempFiles.push(mergedAudioPath, ...segmentAudioPaths);

    // 4) Background music
    bgMusicPath = await downloadBackgroundMusicFromS3(backgroundMusic);
    if (bgMusicPath) tempFiles.push(bgMusicPath);

    // 5) Build SMART plan: moving background + photo overlays
    const catSlug = normalizeCategory(category);

    // Background assignment: user videos first, else stock
    let plan = assignUserVideosSequential(scriptObj.segments, userVideos);
    plan = await fillBackgroundWithStock({ plan, category: catSlug });

    if (plan.some(p => !p.backgroundVideo)) {
      throw new Error('Some segments missing background video after stock fill. Seed your S3 stock prefixes.');
    }

    // Photo overlays assignment (smart, respects order)
    const photoBuckets = distributePhotosToSegments({ segments: scriptObj.segments, photos: userPhotos });
    for (let i = 0; i < plan.length; i++) {
      plan[i].overlayPhotos = photoBuckets[i] || [];
      plan[i].intent = normalizeIntent(scriptObj.segments[i].intent);
      plan[i].onScreenText = scriptObj.segments[i].onScreenText || plan[i].onScreenText || '';
    }

    // 6) Subtitles
    let srtText = null;
    const subtitlesOn = (String(subtitles).toLowerCase() === 'true' || subtitles === true);
    if (subtitlesOn) {
      const { srt } = buildSrtFromSegments({ segments: scriptObj.segments, segmentDurations });
      srtText = srt;
      srtLocalPath = path.join(TEMP_DIR, `subs_${uuidv4()}.srt`);
      fs.writeFileSync(srtLocalPath, srtText, 'utf-8');
      tempFiles.push(srtLocalPath);
    }

    // 7) Render final video
    finalVideoPath = path.join(TEMP_DIR, `ai_video_${uuidv4()}.mp4`);
    await createVideoFromSmartPlan({
      smartPlan: plan,
      segmentDurations,
      outputVideoPath: finalVideoPath,
      voiceAudioPath: mergedAudioPath,
      backgroundMusicPath: bgMusicPath,
      subtitlesSrtPath: subtitlesOn ? srtLocalPath : null,
    });

    // 8) Upload to S3 (OLD LOCATION)
    const uploadId = uuidv4();
    const videoUrl = await uploadVideoToS3(finalVideoPath, uploadId);
    safeUnlink(finalVideoPath);

    let srtUrl = null;
    if (subtitlesOn && srtText) srtUrl = await uploadTextToS3(srtText, uploadId);

    // 9) Register job
    const totalDuration = segmentDurations.reduce((a, b) => a + (b || 0), 0);
    const job = registerJob({
      filePath: videoUrl,
      script: JSON.stringify(scriptObj),
      voice,
      tone,
      duration: totalDuration
    });

    // 10) Deduct wallet after success (atomic)
    const { remainingWalletUnits } = await deductWalletUnitsAtomic({
      pool,
      accountId,
      cost: VIDEO_GENERATION_COST
    });

    return res.json({
      jobId: job.id,
      videoUrl,
      downloadUrl: videoUrl,
      srtUrl,
      expiresAt: new Date(job.expiresAt).toISOString(),
      voice,
      tone,
      category: catSlug,
      script: scriptObj,
      duration: totalDuration,
      backgroundMusic: backgroundMusic || (bgMusicPath ? 'random' : 'none'),
      walletUnitsDeducted: VIDEO_GENERATION_COST,
      remainingWalletUnits,
      // debug info
      smart: {
        userVideos: userVideos.length,
        userPhotos: userPhotos.length,
        plan: plan.map(p => ({
          intent: p.intent,
          usedUserVideo: userVideos.includes(p.backgroundVideo),
          overlayPhotos: (p.overlayPhotos || []).length
        }))
      },
      outputLocation: { bucket: OUTPUT_BUCKET, prefix: S3_VIDEO_PREFIX }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to generate AI video', details: err.message });
  } finally {
    tempFiles.forEach(safeUnlink);
    safeUnlink(bgMusicPath);
    safeUnlink(finalVideoPath);
    safeUnlink(srtLocalPath);
  }
});

// Jobs endpoints
router.get('/ai-video/jobs/:jobId', (req, res) => {
  const job = getActiveJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });

  return res.json({
    jobId: job.id,
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
  return res.json({ success: true });
});

router.get('/ai-video/video/:jobId', (req, res) => {
  const job = getActiveJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Video not found or expired' });
  if (job.path.startsWith('http')) return res.redirect(job.path);
  return res.status(400).json({ error: 'Unexpected local path in job record' });
});

module.exports = router;



