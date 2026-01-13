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
============================ */
const AUDIO_BUCKET = process.env.AUDIO_BUCKET || 'iendorse-audio-assets';
const S3_AUDIO_PREFIX = process.env.S3_AUDIO_PREFIX || 'background-music/';
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || AUDIO_BUCKET;
const S3_VIDEO_PREFIX = process.env.S3_VIDEO_PREFIX || 'ai-generated-videos/';

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
   Tone -> TTS instructions
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
   ✅ NEW: Infer campaign context from `script`
   - category
   - campaignTitle (brand/company name if present)
   - scriptContext (offer, audience, location, keywords, etc.)
   - keywords array for Pexels accuracy
============================ */
function buildScriptInferencePrompt(scriptText) {
  const clipped = String(scriptText || '').slice(0, 4000); // keep prompt bounded
  return `
You are an expert marketing strategist and classifier.

Given the raw campaign text below, infer the TRUE marketing context.
Return JSON ONLY. No markdown. No commentary.

Schema:
{
  "category": "one short category label (e.g. real_estate, restaurant, ecommerce, fintech, ngo, politics, education, health, logistics, events, personal_brand, automotive, beauty, travel, fitness, tech, manufacturing, construction, etc.)",
  "companyOrBrand": "best guess brand/company/person name (empty string if unknown)",
  "offer": "what is being promoted/sold (short)",
  "targetAudience": "who it is for (short)",
  "location": "location(s) mentioned, if any (short)",
  "keywords": ["5-12 specific keywords/phrases for stock video search; include nouns/activities/objects; avoid generic filler"]
}

Campaign Text:
${clipped}
`.trim();
}

async function inferCampaignContextFromScript({ apiKey, scriptText }) {
  if (!apiKey) throw new Error('OpenAI key not configured');
  const text = String(scriptText || '').trim();
  if (!text) {
    return {
      category: 'business',
      campaignTitle: '',
      scriptContext: '',
      keywords: []
    };
  }

  const openai = new OpenAI({ apiKey });

  const r = await openai.chat.completions.create({
    model: process.env.INFER_MODEL || process.env.SCRIPT_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Return JSON only. No markdown. No commentary.' },
      { role: 'user', content: buildScriptInferencePrompt(text) }
    ],
    temperature: 0.3,
  });

  const content = r.choices?.[0]?.message?.content || '{}';
  const json = safeJsonParse(content);

  if (!json) {
    // Safe fallback: use just keywords from text via local extractor later
    return {
      category: 'business',
      campaignTitle: '',
      scriptContext: '',
      keywords: []
    };
  }

  const category = normalizeCategory(json.category || 'business');
  const companyOrBrand = String(json.companyOrBrand || '').trim();
  const offer = String(json.offer || '').trim();
  const targetAudience = String(json.targetAudience || '').trim();
  const location = String(json.location || '').trim();
  const keywords = Array.isArray(json.keywords) ? json.keywords.map(k => String(k || '').trim()).filter(Boolean) : [];

  // Script context is what we feed into segmented script generation and Pexels.
  const scriptContext = [
    companyOrBrand ? `Brand/Company: ${companyOrBrand}` : '',
    offer ? `Offer: ${offer}` : '',
    targetAudience ? `Target Audience: ${targetAudience}` : '',
    location ? `Location: ${location}` : '',
    keywords.length ? `Keywords: ${keywords.slice(0, 12).join(', ')}` : ''
  ].filter(Boolean).join('\n');

  // For campaignTitle: keep it short, but bias towards company/brand if present.
  const campaignTitle = companyOrBrand ? companyOrBrand : '';

  return { category, campaignTitle, scriptContext, keywords };
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
   🎬 PEXELS VIDEO SEARCH
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

/**
 * ✅ UPDATED: Pexels query now also uses:
 * - scriptContext (structured inferred context)
 * - inferredKeywords (explicit list from inference)
 */
function buildPexelsSearchQuery({
  category,
  intent,
  campaignTitle,
  campaignDescription,
  segmentText,
  scriptContext,
  inferredKeywords
}) {
  const it = normalizeIntent(intent);

  const titleKeywords = extractKeywords(campaignTitle);
  const descKeywords = extractKeywords(campaignDescription);
  const segmentKeywords = extractKeywords(segmentText);
  const contextKeywords = extractKeywords(scriptContext);

  const inferred = Array.isArray(inferredKeywords)
    ? inferredKeywords.map(k => String(k || '').toLowerCase().trim()).filter(Boolean)
    : [];

  // Combine & dedupe, prioritizing:
  // inferred keywords > title > description > context > segment
  const allKeywords = [
    ...inferred.slice(0, 6),
    ...titleKeywords.slice(0, 3),
    ...descKeywords.slice(0, 2),
    ...contextKeywords.slice(0, 2),
    ...segmentKeywords.slice(0, 2),
  ];

  const uniqueKeywords = [...new Set(allKeywords)].filter(Boolean);

  const intentVisuals = {
    hook: ['dynamic', 'energetic', 'engaging', 'attention'],
    problem: ['challenge', 'struggle', 'difficulty', 'concern'],
    solution: ['success', 'achievement', 'innovation', 'transform'],
    cta: ['action', 'people', 'hands', 'interaction'],
    general: ['professional', 'modern', 'clean']
  };

  const intentTerms = intentVisuals[it] || intentVisuals.general;

  let query = '';

  if (uniqueKeywords.length > 0) {
    query = uniqueKeywords.slice(0, 3).join(' ');
    query += ` ${intentTerms[0]}`;
  } else {
    const cat = normalizeCategory(category);
    query = `${cat.replace(/_/g, ' ')} ${intentTerms[0]}`;
  }

  return query.trim();
}

async function fetchPexelsVideo({
  apiKey,
  category,
  intent,
  campaignTitle,
  campaignDescription,
  segmentText,
  scriptContext,
  inferredKeywords
}) {
  if (!apiKey) throw new Error('Pexels API key not configured');

  const query = buildPexelsSearchQuery({
    category,
    intent,
    campaignTitle,
    campaignDescription,
    segmentText,
    scriptContext,
    inferredKeywords
  });

  console.log(`[Pexels] Searching for: "${query}" (intent: ${intent})`);

  try {
    const response = await axios.get('https://api.pexels.com/videos/search', {
      params: {
        query,
        orientation: 'portrait',
        size: 'medium',
        per_page: 15
      },
      headers: { 'Authorization': apiKey },
      timeout: 10000
    });

    const videos = response.data?.videos || [];
    if (!videos.length) {
      const fallbackQuery = (Array.isArray(inferredKeywords) && inferredKeywords[0])
        ? inferredKeywords[0]
        : (extractKeywords(campaignTitle || campaignDescription || scriptContext || '')[0] || 'business professional');

      console.log(`[Pexels] No results, trying fallback: "${fallbackQuery}"`);

      const fallbackResponse = await axios.get('https://api.pexels.com/videos/search', {
        params: {
          query: fallbackQuery,
          orientation: 'portrait',
          size: 'medium',
          per_page: 15
        },
        headers: { 'Authorization': apiKey },
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

async function downloadPexelsVideo({
  apiKey,
  category,
  intent,
  campaignTitle,
  campaignDescription,
  segmentText,
  scriptContext,
  inferredKeywords
}) {
  const video = await fetchPexelsVideo({
    apiKey,
    category,
    intent,
    campaignTitle,
    campaignDescription,
    segmentText,
    scriptContext,
    inferredKeywords
  });

  const videoFiles = video.video_files || [];
  const portraitFile = videoFiles.find(f =>
    f.width && f.height && f.height > f.width && f.quality === 'hd'
  ) || videoFiles.find(f =>
    f.width && f.height && f.height > f.width
  ) || videoFiles[0];

  if (!portraitFile?.link) throw new Error('No suitable video file found');

  const localPath = path.join(TEMP_DIR, `pexels_${uuidv4()}.mp4`);

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

  return localPath;
}

/* ============================
   Segmented script generator
============================ */
// function buildSegmentedScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone, category }) {
//   return `
// You are a campaign copywriter for small and medium business owners.

// Return JSON ONLY:
// {
//   "title": "5-10 word title INCLUDING the company name",
//   "description": "1-2 sentence summary (<= 200 chars)",
//   "segments": [
//     { "id": "hook", "intent": "hook", "text": "2-3 sentence"},
//     { "id": "problem", "intent": "problem", "text": "2-3 sentences"},
//     { "id": "solution", "intent": "solution", "text": "2-3 sentences"},
//     { "id": "cta", "intent": "cta", "text": "2-3 short sentence"}
//   ]
// }

// Tone: ${tone || 'friendly'}
// Voice Talent: ${voice || 'default'}
// Category: ${category || 'general'}

// Campaign Title: ${campaignTitle || 'Untitled Campaign'}
// Campaign Description: ${campaignDescription || 'N/A'}
// Additional Context: ${scriptContext || 'N/A'}
// `;
// }

function buildSegmentedScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone, category }) {
  // Auto-detect if this is news content based on category or context
  const newsCategories = [
    'news', 'breaking news', 'update', 'updates', 'innovation', 
    'announcement', 'press release', 'industry news', 'technology news',
    'market update', 'company news', 'product launch news'
  ];
  
  const isNews = newsCategories.some(cat => 
    (category || '').toLowerCase().includes(cat) ||
    (campaignTitle || '').toLowerCase().includes('news') ||
    (campaignTitle || '').toLowerCase().includes('update') ||
    (campaignDescription || '').toLowerCase().includes('breaking')
  );

  if (isNews) {
    // NEWS PROMPT
    return `
You are a professional broadcast news writer creating scripts for video news segments similar to CNN, BBC, or Reuters.

Return JSON ONLY:
{
  "title": "5-10 word news headline",
  "description": "1-2 sentence news summary (<= 200 chars)",
  "segments": [
    { "id": "lede", "intent": "lede", "text": "2-3 sentences opening with the most critical information (who, what, when, where)"},
    { "id": "context", "intent": "context", "text": "2-3 sentences providing background and why this matters"},
    { "id": "details", "intent": "details", "text": "2-3 sentences with key facts, quotes, or data"},
    { "id": "impact", "intent": "impact", "text": "2-3 sentences on implications and what comes next"}
  ]
}

Writing Guidelines:
- Use active voice and present tense for immediacy
- Lead with the most newsworthy information
- Be factual, objective, and authoritative
- Write for spoken delivery (shorter sentences, natural rhythm)
- Avoid jargon unless explaining it
- Include attribution for claims and sources where relevant

Tone: ${tone || 'authoritative and professional'}
Voice Talent: ${voice || 'default'}
Category: ${category || 'breaking news'}

News Title: ${campaignTitle || 'Breaking News'}
News Description: ${campaignDescription || 'N/A'}
Additional Context: ${scriptContext || 'N/A'}
`;
  } else {
    // MARKETING PROMPT
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
============================ */
function distributePhotosToSegments({ segments, photos }) {
  if (!photos.length) return segments.map(() => []);

  const n = segments.length;
  const buckets = Array.from({ length: n }, () => []);

  const first = photos[0];
  const last = photos.length > 1 ? photos[photos.length - 1] : null;

  buckets[0].push(first);
  if (last && last !== first) buckets[n - 1].push(last);

  const middle = photos.slice(1, last ? -1 : 1);

  if (middle.length) {
    let idx = 1;
    const endIdx = Math.max(1, n - 2);
    for (const p of middle) {
      buckets[idx].push(p);
      idx++;
      if (idx > endIdx) idx = 1;
    }
  }

  for (let i = 0; i < buckets.length; i++) {
    const cap = (segments[i]?.intent === 'solution') ? 3 : 2;
    buckets[i] = buckets[i].slice(0, cap);
  }

  return buckets;
}

/* ============================
   Render plan with Pexels
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
      backgroundVideo: picked,
      overlayPhotos: [],
    });
  }
  return plan;
}

async function fillBackgroundWithPexels({
  plan,
  category,
  pexelsApiKey,
  campaignTitle,
  campaignDescription,
  scriptContext,
  inferredKeywords,
  segments
}) {
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    if (item.backgroundVideo) continue;

    try {
      const segment = segments[i];
      item.backgroundVideo = await downloadPexelsVideo({
        apiKey: pexelsApiKey,
        category,
        intent: item.intent,
        campaignTitle,
        campaignDescription,
        segmentText: segment?.text || '',
        scriptContext,
        inferredKeywords
      });
    } catch (err) {
      console.error(`Failed to fetch Pexels video for segment ${i} (${item.intent}):`, err.message);
    }
  }
  return plan;
}

/* ============================
   FFmpeg: segment clip
============================ */
// async function createSegmentClip({
//   bgVideoPath,
//   overlayPhotoPaths,
//   durationSec,
//   outPath
// }) {
//   if (!bgVideoPath || !fs.existsSync(bgVideoPath)) {
//     throw new Error('Missing bg video for segment.');
//   }

//   const dur = Math.max(0.8, Number(durationSec || 0.8));
//   const photos = Array.isArray(overlayPhotoPaths) ? overlayPhotoPaths.filter(p => p && fs.existsSync(p)) : [];
//   const numPhotos = photos.length;

//   const cmd = ffmpeg()
//     .input(bgVideoPath)
//     .inputOptions(['-stream_loop', '10']);

//   for (const p of photos) {
//     cmd.input(p).inputOptions(['-loop', '1']);
//   }

//   const filters = [];

//   filters.push(
//     `[0:v]` +
//     `scale=1080:1920:force_original_aspect_ratio=increase,` +
//     `crop=1080:1920,` +
//     `setsar=1,fps=30,format=yuv420p,trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[base]`
//   );

//   let lastLabel = 'base';

//   if (numPhotos > 0) {
//     let maxSpotlights = Math.min(numPhotos, 2);
//     if (dur < 3.8 && maxSpotlights === 2) maxSpotlights = 1;

//     const picked = photos.slice(0, maxSpotlights);

//     const PHOTO_MIN_SEC = Number(process.env.PHOTO_MIN_SEC || 4);
//     const PHOTO_MAX_SEGMENT_SHARE = Number(process.env.PHOTO_MAX_SHARE || 0.95);
//     const PHOTO_LEADIN_SEC = Number(process.env.PHOTO_LEADIN_SEC || 0.05);

//     const spotlightTotal = Math.min(
//       dur * PHOTO_MAX_SEGMENT_SHARE,
//       Math.max(PHOTO_MIN_SEC * maxSpotlights, PHOTO_MIN_SEC)
//     );

//     const slot = spotlightTotal / maxSpotlights;
//     const startOffset = Math.min(PHOTO_LEADIN_SEC, dur * 0.10);

//     for (let i = 0; i < maxSpotlights; i++) {
//       const inputIndex = i + 1;
//       const st = Math.min(dur - 0.2, startOffset + i * slot);
//       const en = Math.min(dur, st + slot);

//       const fadeIn = Math.min(0.25, (en - st) * 0.25);
//       const fadeOut = Math.min(0.25, (en - st) * 0.25);

//       const frames = Math.max(24, Math.round((en - st) * 30));

//       filters.push(
//         `[${inputIndex}:v]` +
//         `scale=2400:-1:force_original_aspect_ratio=increase,` +
//         `zoompan=` +
//           `z='min(zoom+0.0012,1.12)':` +
//           `x='iw/2-(iw/zoom/2)':` +
//           `y='ih/2-(ih/zoom/2)':` +
//           `d=${frames}:` +
//           `s=1080x1920:` +
//           `fps=30,` +
//         `format=rgba,` +
//         `fade=t=in:st=0:d=${fadeIn.toFixed(3)}:alpha=1,` +
//         `fade=t=out:st=${Math.max(0, (en - st) - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1[sp${i}]`
//       );

//       filters.push(`[sp${i}]setpts=PTS+${st.toFixed(3)}/TB[sp${i}t]`);

//       filters.push(
//         `[${lastLabel}][sp${i}t]overlay=0:0:enable=between(t\\,${st.toFixed(3)}\\,${en.toFixed(3)})[v${i}]`
//       );

//       lastLabel = `v${i}`;
//     }
//   }

//   filters.push(`[${lastLabel}]null[vout]`);
//   const filtergraph = filters.join(';');

//   await new Promise((resolve, reject) => {
//     cmd
//       .outputOptions([
//         '-t', String(dur),
//         '-filter_complex', filtergraph,
//         '-map', '[vout]',
//         '-c:v', 'libx264',
//         '-preset', 'ultrafast',
//         '-crf', '30',
//         '-pix_fmt', 'yuv420p',
//         '-an',
//         '-movflags', '+faststart',
//       ])
//       .output(outPath)
//       .on('end', resolve)
//       .on('error', (err, _stdout, stderr) => reject(new Error(stderr || err.message)))
//       .run();
//   });
// }

async function createSegmentClip({
  bgVideoPath,
  overlayPhotoPaths,
  durationSec,
  outPath
}) {
  if (!bgVideoPath || !fs.existsSync(bgVideoPath)) {
    throw new Error('Missing bg video for segment.');
  }

  const dur = Math.max(0.8, Number(durationSec || 0.8));
  const photos = Array.isArray(overlayPhotoPaths)
    ? overlayPhotoPaths.filter(p => p && fs.existsSync(p))
    : [];
  const numPhotos = photos.length;

  const cmd = ffmpeg()
    .input(bgVideoPath)
    .inputOptions(['-stream_loop', '10']); // loop background long enough

  // add all photos as inputs (we’ll only “spotlight” the first 1–2)
  for (const p of photos) {
    cmd.input(p).inputOptions(['-loop', '1']);
  }

  const filters = [];

  // Background: fill the screen, moving video visible from the beginning
  filters.push(
    `[0:v]` +
      `scale=1080:1920:force_original_aspect_ratio=increase,` +
      `crop=1080:1920,` +
      `setsar=1,fps=30,format=yuv420p,` +
      `trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[base]`
  );

  let lastLabel = 'base';

  // ✅ NEW BEHAVIOR: photo(s) appear at the END of the segment (ad-like “lock-in”)
  if (numPhotos > 0) {
    let maxSpotlights = Math.min(numPhotos, 2);
    if (dur < 3.8 && maxSpotlights === 2) maxSpotlights = 1;

    // We only spotlight the first N photos (respects user ordering)
    const picked = photos.slice(0, maxSpotlights);

    // Tuning knobs
    const PHOTO_MIN_SEC = Number(process.env.PHOTO_MIN_SEC || 4);        // minimum per photo, but clamped by segment length
    const PHOTO_MAX_SEGMENT_SHARE = Number(process.env.PHOTO_MAX_SHARE || 0.95); // don’t cover the whole segment
    const PHOTO_TAIL_SEC = Number(process.env.PHOTO_TAIL_SEC || 0);      // optional: force EXACT tail duration (0 = auto)

    // How much total time can photos occupy in this segment?
    let spotlightTotal = Math.min(
      dur * PHOTO_MAX_SEGMENT_SHARE,
      Math.max(PHOTO_MIN_SEC * maxSpotlights, PHOTO_MIN_SEC)
    );

    // If you want “always last X seconds”, set PHOTO_TAIL_SEC > 0
    if (PHOTO_TAIL_SEC > 0) {
      spotlightTotal = Math.min(spotlightTotal, Math.max(0.9, PHOTO_TAIL_SEC));
    }

    // Put the spotlight block at the END of the segment
    const startOffset = Math.max(0, dur - spotlightTotal);
    const slot = spotlightTotal / maxSpotlights;

    for (let i = 0; i < maxSpotlights; i++) {
      // IMPORTANT: input index is 1..N because 0 is bg video
      const inputIndex = i + 1;

      const st = Math.max(0, Math.min(dur - 0.05, startOffset + i * slot));
      const en = Math.min(dur, st + slot);

      // Fade-in is good; fade-out can be tiny or zero because we cut to next segment anyway
      const fadeIn = Math.min(0.22, (en - st) * 0.22);
      const fadeOut = Number(process.env.PHOTO_FADEOUT_SEC || 0.06); // small tail fade to avoid harsh cut

      const frames = Math.max(24, Math.round((en - st) * 30));

      // Fullscreen “Ken Burns” photo (zoom) that fills 1080x1920
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
          // fade-out near end of the spotlight clip (relative time inside this stream)
          `fade=t=out:st=${Math.max(0, (en - st) - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1[sp${i}]`
      );

      // Shift the photo stream to start at absolute time "st"
      filters.push(`[sp${i}]setpts=PTS+${st.toFixed(3)}/TB[sp${i}t]`);

      // Overlay fullscreen (0:0) only during [st, en]
      filters.push(
        `[${lastLabel}][sp${i}t]overlay=0:0:enable=between(t\\,${st.toFixed(3)}\\,${en.toFixed(3)})[v${i}]`
      );

      lastLabel = `v${i}`;
    }
  }

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
   Upload output to S3
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

// script (unchanged)
// router.post('/ai-video/script', upload.none(), async (req, res) => {
//   const {
//     campaignTitle,
//     campaignDescription,
//     scriptContext,
//     category,
//     voice = 'Ava',
//     tone = 'friendly',
//     accountId
//   } = req.body;

//   if (!accountId) {
//     return res.status(400).json({ error: 'accountId is required' });
//   }

//   const categorySlug = normalizeCategory(category);

//   const apiKey = req.openai_api_key || process.env.OPENAI_API_KEY;
//   if (!apiKey) {
//     return res.status(500).json({ error: 'OpenAI key not configured' });
//   }

//   try {
//     const scriptObj = await generateSegmentedScript({
//       apiKey,
//       payload: {
//         campaignTitle,
//         campaignDescription,
//         scriptContext,
//         category: categorySlug,
//         voice,
//         tone
//       }
//     });

//     const pool = getDbPoolFromReq(req);
//     const { remainingWalletUnits } = await deductWalletUnitsAtomic({
//       pool,
//       accountId,
//       cost: SCRIPT_GENERATION_COST
//     });

//     return res.json({
//       ...scriptObj,
//       category: categorySlug,
//       voice,
//       tone,
//       walletUnitsDeducted: SCRIPT_GENERATION_COST,
//       remainingWalletUnits
//     });

//   } catch (err) {
//     return res.status(500).json({
//       error: 'Failed to generate script',
//       details: err.message
//     });
//   }
// });

//You are an AI video copywriter for IEndorse campaigns.

function buildScriptPrompt({ campaignTitle, campaignDescription, scriptContext, voice, tone }) {
    return `

You are a News Broadcaster that deliver information, innovation, updates and breakthroughs.
Write a short but punchy video script that ALWAYS includes the company name inside the video title using the details below.
Voice Talent: ${voice || 'Default'}
Tone: ${tone || 'Professional'}

Return JSON ONLY in the following format:
{
  "title": "punchy 5-10 word video title",
  "description": "1-2 sentence summary (max ~200 characters) of the story viewers will hear",
  "script": "full script text",
  "talkingPoints": ["bullet 1", "bullet 2"]
}

Campaign Title (MUST include company name): ${campaignTitle || 'Untitled Campaign'}
Campaign Description: ${campaignDescription || 'N/A'}
Additional Context: ${scriptContext || 'news, updates, information, innovation, breakthroughs'}
`;
}
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
//USE THE ORIGINAL GENERATE SCRIPT
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

// ✅ UPDATED generate-video (accepts `script` payload and infers category/context)
router.post('/ai-video/generate-video', upload.none(), async (req, res) => {
  let {
    // frontend payload:
    // script, voice, tone, media, backgroundMusic, accountId
    script,

    // still supported (backwards compatible):
    category,
    campaignTitle,
    campaignDescription,
    scriptContext,
    segments,

    voice = 'Ava',
    tone = 'friendly',
    media,
    backgroundMusic,
    subtitles = false,
    accountId
  } = req.body;

  if (!accountId) return res.status(400).json({ error: 'accountId is required' });

  // Normalize tone if frontend sends "Friendly"
  tone = String(tone || 'friendly').toLowerCase().trim();

  // ✅ Core requirement: use script as campaignDescription
  // (but keep backward compatibility if script not provided)
  const scriptAsDescription = String(script || '').trim();
  if (scriptAsDescription) {
    campaignDescription = scriptAsDescription;
  } else {
    campaignDescription = String(campaignDescription || '').trim();
  }

  if (typeof media === 'string') {
    try { media = JSON.parse(media); } catch { return res.status(400).json({ error: 'media must be valid JSON array' }); }
  }
  if (media && !Array.isArray(media)) return res.status(400).json({ error: 'media must be an array of {filePath}' });

  if (typeof segments === 'string') {
    try { segments = JSON.parse(segments); } catch { return res.status(400).json({ error: 'segments must be valid JSON array' }); }
  }

  const openaiApiKey = req.openai_api_key || process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return res.status(500).json({ error: 'OpenAI key not configured' });

  const pexelsApiKey = req.pexels_api_key;
  if (!pexelsApiKey) return res.status(500).json({ error: 'Pexels API key not configured' });

  const tempFiles = [];
  let bgMusicPath = null;
  let finalVideoPath = null;
  let srtLocalPath = null;

  // These are what we will feed into script generation & pexels
  let inferredCategorySlug = normalizeCategory(category);
  let inferredCampaignTitle = String(campaignTitle || '').trim();
  let inferredScriptContext = String(scriptContext || '').trim();
  let inferredKeywords = [];

  try {
    const pool = getDbPoolFromReq(req);

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

    // ✅ NEW: Infer category + context primarily from the script (campaignDescription)
    // Only do inference if script was provided or if category is missing/too generic.
    const shouldInfer = Boolean(scriptAsDescription) || !String(category || '').trim();
    if (shouldInfer) {
      const inferred = await inferCampaignContextFromScript({
        apiKey: openaiApiKey,
        scriptText: campaignDescription
      });

      inferredCategorySlug = normalizeCategory(inferred.category || inferredCategorySlug || 'business');

      // If frontend didn’t provide a title, use inferred brand name
      if (!inferredCampaignTitle) inferredCampaignTitle = String(inferred.campaignTitle || '').trim();

      // If frontend didn’t provide extra context, use inferred structured context
      if (!inferredScriptContext) inferredScriptContext = String(inferred.scriptContext || '').trim();

      inferredKeywords = Array.isArray(inferred.keywords) ? inferred.keywords : [];
    }

    // 1) Script segments
    let scriptObj;
    if (Array.isArray(segments) && segments.length) {
      // If caller passed segments explicitly, keep them.
      scriptObj = {
        title: String(inferredCampaignTitle || '').trim(),
        description: '',
        segments: enforceIntents(segments),
      };
    } else {
      // Otherwise: generate from inferred + script-as-description
      scriptObj = await generateSegmentedScript({
        apiKey: openaiApiKey,
        payload: {
          campaignTitle: inferredCampaignTitle,
          campaignDescription,               // ✅ script is here
          scriptContext: inferredScriptContext,
          category: inferredCategorySlug,
          voice,
          tone
        }
      });
    }
    if (!scriptObj.segments?.length) throw new Error('No script segments available.');

    // 2) Download user media
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

    // 3) Voiceover
    const { mergedAudioPath, segmentAudioPaths, segmentDurations } =
      await synthesizeVoiceOverBySegments({ segments: scriptObj.segments, voice, tone, apiKey: openaiApiKey });

    tempFiles.push(mergedAudioPath, ...segmentAudioPaths);

    // 4) Background music
    bgMusicPath = await downloadBackgroundMusicFromS3(backgroundMusic);
    if (bgMusicPath) tempFiles.push(bgMusicPath);

    // 5) Build plan with Pexels (now uses inferred context + keywords)
    let plan = assignUserVideosSequential(scriptObj.segments, userVideos);
    plan = await fillBackgroundWithPexels({
      plan,
      category: inferredCategorySlug,
      pexelsApiKey,
      campaignTitle: inferredCampaignTitle,
      campaignDescription, // ✅ still script-as-description
      scriptContext: inferredScriptContext,
      inferredKeywords,
      segments: scriptObj.segments
    });

    if (plan.some(p => !p.backgroundVideo)) {
      throw new Error('Some segments missing background video after Pexels fetch.');
    }

    // 6) Photo overlays
    const photoBuckets = distributePhotosToSegments({ segments: scriptObj.segments, photos: userPhotos });
    for (let i = 0; i < plan.length; i++) {
      plan[i].overlayPhotos = photoBuckets[i] || [];
      plan[i].intent = normalizeIntent(scriptObj.segments[i].intent);
      plan[i].onScreenText = scriptObj.segments[i].onScreenText || plan[i].onScreenText || '';
    }

    // 7) Subtitles
    let srtText = null;
    const subtitlesOn = (String(subtitles).toLowerCase() === 'true' || subtitles === true);
    if (subtitlesOn) {
      const { srt } = buildSrtFromSegments({ segments: scriptObj.segments, segmentDurations });
      srtText = srt;
      srtLocalPath = path.join(TEMP_DIR, `subs_${uuidv4()}.srt`);
      fs.writeFileSync(srtLocalPath, srtText, 'utf-8');
      tempFiles.push(srtLocalPath);
    }

    // 8) Render video
    finalVideoPath = path.join(TEMP_DIR, `ai_video_${uuidv4()}.mp4`);
    await createVideoFromSmartPlan({
      smartPlan: plan,
      segmentDurations,
      outputVideoPath: finalVideoPath,
      voiceAudioPath: mergedAudioPath,
      backgroundMusicPath: bgMusicPath,
      subtitlesSrtPath: subtitlesOn ? srtLocalPath : null,
    });

    // 9) Upload to S3
    const uploadId = uuidv4();
    const videoUrl = await uploadVideoToS3(finalVideoPath, uploadId);
    safeUnlink(finalVideoPath);

    let srtUrl = null;
    if (subtitlesOn && srtText) srtUrl = await uploadTextToS3(srtText, uploadId);

    // 10) Register job
    const totalDuration = segmentDurations.reduce((a, b) => a + (b || 0), 0);
    const job = registerJob({
      filePath: videoUrl,
      script: JSON.stringify(scriptObj),
      voice,
      tone,
      duration: totalDuration
    });

    // 11) Deduct wallet
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
      category: inferredCategorySlug,
      inferred: {
        campaignTitle: inferredCampaignTitle,
        scriptContext: inferredScriptContext,
        keywords: inferredKeywords
      },
      script: scriptObj,
      duration: totalDuration,
      backgroundMusic: backgroundMusic || (bgMusicPath ? 'random' : 'none'),
      walletUnitsDeducted: VIDEO_GENERATION_COST,
      remainingWalletUnits,
      videoSource: 'pexels',
      smart: {
        userVideos: userVideos.length,
        userPhotos: userPhotos.length,
        pexelsVideosUsed: plan.filter(p => !userVideos.includes(p.backgroundVideo)).length,
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
