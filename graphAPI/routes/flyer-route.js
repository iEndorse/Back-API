/**
 * ============================================================
 *  CAMPAIGN FLYER GENERATOR
 *  POST /ai-video/generate-flyer
 *
 *  Accepts the same inputs as generate-video but produces a
 *  beautiful campaign flyer PNG (uploaded to S3) instead of
 *  a video.
 *
 *  New inputs vs generate-video:
 *    - flyerStyle  : "bold" | "minimal" | "luxury" | "news" | "event" (default: auto-detected)
 *    - tagline     : optional override for the main tagline text
 *    - ctaText     : optional override for the call-to-action button text
 *    - colorScheme : "auto" | hex pair e.g. "#FF4500,#1A1A2E"  (default: auto)
 *    - logoUrl     : optional URL to a logo image
 *
 *  Everything else (script, media, voice, tone, accountId, etc.)
 *  is consumed the same way as in generate-video.
 * ============================================================
 */

const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const multer   = require('multer');
const { OpenAI } = require('openai');
const AWS      = require('aws-sdk');
const sql      = require('mssql');
const puppeteer = require('puppeteer-core');

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
const upload = multer();

/* ============================
   Re-use config from host file
   (these mirror the values in
   the main ai-video router)
============================ */
const TEMP_DIR = process.env.AWS_EXECUTION_ENV ? '/tmp' : path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const AUDIO_BUCKET   = process.env.AUDIO_BUCKET   || 'iendorse-audio-assets';
const OUTPUT_BUCKET  = process.env.OUTPUT_BUCKET  || AUDIO_BUCKET;
const S3_FLYER_PREFIX = process.env.S3_FLYER_PREFIX || 'ai-generated-flyers/';
const FLYER_COST     = parseInt(process.env.FLYER_GENERATION_COST || '3', 10);

const s3 = new AWS.S3();

/* ============================
   Helpers (mirrors from host)
============================ */
function safeJsonParse(s)  { try { return JSON.parse(s); } catch { return null; } }
function isUrl(p)           { return typeof p === 'string' && /^https?:\/\//i.test(p); }
function isImagePath(p)     { return /\.(jpg|jpeg|png|webp)$/i.test(String(p || '')); }
function safeUnlink(p)      { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} }

function normalizeCategory(cat) {
  const c = String(cat || 'business').toLowerCase().trim()
    .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return c || 'business';
}

function getDbPoolFromReq(req) {
  const pool = req?.app?.locals?.db;
  if (!pool || !pool.connected) throw new Error('Database pool not available');
  return pool;
}

async function deductWalletUnitsAtomic({ pool, accountId, cost }) {
  const q = `
    UPDATE Accounts SET WalletUnits = WalletUnits - @cost
    WHERE Id = @accountId AND WalletUnits >= @cost;
    SELECT @@ROWCOUNT AS rowsAffected;
    SELECT Id, WalletUnits FROM Accounts WHERE Id = @accountId;
  `;
  const r = await pool.request()
    .input('accountId', sql.Int, parseInt(accountId, 10))
    .input('cost', sql.Int, cost)
    .query(q);
  const rowsAffected = r.recordsets?.[0]?.[0]?.rowsAffected || 0;
  const account      = r.recordsets?.[1]?.[0];
  if (!account)        throw new Error('Account not found.');
  if (!rowsAffected)   throw new Error(`Insufficient wallet units. You have ${account.WalletUnits} but need ${cost}.`);
  return { remainingWalletUnits: account.WalletUnits };
}

async function downloadFileIfNeeded(filePath) {
  if (!filePath) throw new Error('filePath required');
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

async function uploadFlyerToS3(localPath, flyerId) {
  const result = await s3.upload({
    Bucket: OUTPUT_BUCKET,
    Key: `${S3_FLYER_PREFIX}${flyerId}.png`,
    Body: fs.createReadStream(localPath),
    ContentType: 'image/png',
  }).promise();
  return result.Location;
}

/* ============================
   AI: Infer flyer content
============================ */
async function inferFlyerContent({ apiKey, scriptText, campaignTitle, campaignDescription, tone, flyerStyle, tagline, ctaText, category }) {
  const openai = new OpenAI({ apiKey });

  const prompt = `
You are a world-class graphic design director and copywriter.
Given the campaign details below, produce compelling flyer copy and design direction.

Return JSON ONLY (no markdown, no commentary):
{
  "headline":      "Short, punchy headline (max 8 words)",
  "subheadline":   "Supporting line (max 15 words)",
  "tagline":       "Memorable tagline (max 10 words)",
  "bodyText":      "2-3 sentence body copy that sells",
  "ctaText":       "Call-to-action button text (max 5 words)",
  "keyPoints":     ["benefit 1", "benefit 2", "benefit 3"],
  "colorPrimary":  "#hexcolor  — bold, emotion-evoking primary color matching the brand/tone",
  "colorAccent":   "#hexcolor  — complementary accent (good contrast with primary)",
  "colorBg":       "#hexcolor  — background (light or dark, never plain white unless luxury/minimal)",
  "colorText":     "#hexcolor  — main text color (readable on bg)",
  "designMood":    "one of: bold | luxury | minimal | news | event | corporate | playful | urgent",
  "suggestedEmoji":"1-2 thematic emojis that match the campaign"
}

Category: ${category || 'business'}
Tone: ${tone || 'professional'}
Requested Style: ${flyerStyle || 'auto'}
Campaign Title: ${campaignTitle || ''}
Campaign Description: ${campaignDescription || scriptText || ''}
${tagline  ? `Tagline override: ${tagline}` : ''}
${ctaText  ? `CTA override: ${ctaText}` : ''}
`.trim();

  const r = await openai.chat.completions.create({
    model: process.env.SCRIPT_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Return JSON only. No markdown. No commentary.' },
      { role: 'user',   content: prompt }
    ],
    temperature: 0.7,
  });

  const raw  = r.choices?.[0]?.message?.content || '{}';
  const json = safeJsonParse(raw);
  if (!json) throw new Error('AI did not return valid JSON for flyer content');

  // Apply overrides
  if (tagline) json.tagline = tagline;
  if (ctaText) json.ctaText = ctaText;

  return json;
}

/* ============================
   Flyer HTML renderer
============================ */
function buildFlyerHtml({ content, logoBase64, heroBase64, logoMimeType, heroMimeType, brandName }) {
  const {
    headline      = 'Your Campaign',
    subheadline   = '',
    tagline       = '',
    bodyText      = '',
    ctaText       = 'Learn More',
    keyPoints     = [],
    colorPrimary  = '#E63946',
    colorAccent   = '#FFD700',
    colorBg       = '#0D1B2A',
    colorText     = '#FFFFFF',
    designMood    = 'bold',
    suggestedEmoji = ''
  } = content;

  // Pick a font pairing based on mood
  const fontPairings = {
    bold:      { display: 'Bebas Neue',       body: 'Barlow Condensed' },
    luxury:    { display: 'Playfair Display',  body: 'Cormorant Garamond' },
    minimal:   { display: 'DM Sans',           body: 'DM Sans' },
    news:      { display: 'Libre Baskerville', body: 'Source Sans 3' },
    event:     { display: 'Montserrat',        body: 'Nunito' },
    corporate: { display: 'Raleway',           body: 'Open Sans' },
    playful:   { display: 'Fredoka One',       body: 'Nunito' },
    urgent:    { display: 'Anton',             body: 'Roboto Condensed' },
  };

  const fonts = fontPairings[designMood] || fontPairings.bold;
  const gFont = encodeURIComponent(`${fonts.display}:wght@400;700&family=${fonts.body}:wght@300;400;600`);

  // Mood-specific decorative accents
  const moodAccents = {
    bold: `
      <div class="accent-bar"></div>
      <div class="corner-bracket top-left"></div>
      <div class="corner-bracket bottom-right"></div>`,
    luxury: `<div class="luxury-ornament">✦</div>`,
    news: `<div class="news-banner">BREAKING</div>`,
    event: `<div class="event-starburst"></div>`,
    urgent: `<div class="urgent-stripe"></div>`,
    minimal: '',
    corporate: '',
    playful: `<div class="playful-dots"></div>`,
  };

  const heroSection = heroBase64
    ? `<div class="hero-image-wrap">
         <img class="hero-image" src="data:${heroMimeType || 'image/jpeg'};base64,${heroBase64}" alt="Campaign visual" />
         <div class="hero-overlay"></div>
       </div>`
    : `<div class="hero-gradient"></div>`;

  const logoSection = logoBase64
    ? `<img class="logo" src="data:${logoMimeType || 'image/png'};base64,${logoBase64}" alt="Logo" />`
    : (brandName ? `<div class="brand-name-text">${brandName}</div>` : '');

  const keyPointsHtml = keyPoints.slice(0, 3).map(pt => `
    <div class="key-point">
      <span class="kp-dot"></span>
      <span>${pt}</span>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=1080"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=${gFont}&display=swap" rel="stylesheet"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --primary:  ${colorPrimary};
    --accent:   ${colorAccent};
    --bg:       ${colorBg};
    --text:     ${colorText};
    --font-display: '${fonts.display}', sans-serif;
    --font-body:    '${fonts.body}', sans-serif;
  }

  html, body {
    width: 1080px;
    height: 1350px;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-body);
  }

  .flyer {
    position: relative;
    width: 1080px;
    height: 1350px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* ── Hero ── */
  .hero-image-wrap {
    position: absolute; inset: 0;
    z-index: 0;
  }
  .hero-image {
    width: 100%; height: 100%;
    object-fit: cover;
    object-position: center top;
    filter: brightness(0.45) saturate(1.2);
  }
  .hero-overlay {
    position: absolute; inset: 0;
    background: linear-gradient(
      160deg,
      ${colorBg}cc 0%,
      ${colorBg}44 40%,
      ${colorPrimary}33 80%,
      ${colorBg}ee 100%
    );
  }
  .hero-gradient {
    position: absolute; inset: 0;
    z-index: 0;
    background:
      radial-gradient(ellipse 120% 80% at 70% 20%, ${colorPrimary}55 0%, transparent 60%),
      radial-gradient(ellipse 80% 60% at 20% 80%, ${colorAccent}33 0%, transparent 55%),
      linear-gradient(135deg, ${colorBg} 0%, #0a0a14 100%);
  }

  /* ── Noise texture overlay ── */
  .flyer::before {
    content: '';
    position: absolute; inset: 0; z-index: 1; pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
    opacity: 0.06;
  }

  /* ── Content layer ── */
  .content {
    position: relative; z-index: 10;
    display: flex; flex-direction: column;
    height: 100%; padding: 64px 72px;
  }

  /* ── Logo / Brand ── */
  .logo-wrap { margin-bottom: 40px; }
  .logo { max-height: 72px; max-width: 260px; object-fit: contain; filter: brightness(1.1) drop-shadow(0 2px 8px rgba(0,0,0,0.4)); }
  .brand-name-text {
    font-family: var(--font-display);
    font-size: 28px; letter-spacing: 4px; text-transform: uppercase;
    color: var(--accent);
  }

  /* ── Mood accents ── */
  .accent-bar {
    position: absolute; top: 0; left: 0;
    width: 8px; height: 100%;
    background: linear-gradient(180deg, var(--accent) 0%, var(--primary) 100%);
  }
  .corner-bracket {
    position: absolute; width: 60px; height: 60px;
    border: 4px solid var(--accent); opacity: 0.6;
  }
  .corner-bracket.top-left    { top: 40px; left: 40px; border-right: none; border-bottom: none; }
  .corner-bracket.bottom-right { bottom: 40px; right: 40px; border-left: none; border-top: none; }
  .luxury-ornament {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    font-size: 600px; opacity: 0.02; color: var(--accent);
    pointer-events: none; user-select: none;
  }
  .news-banner {
    display: inline-block;
    background: var(--primary); color: #fff;
    font-family: var(--font-display); font-size: 18px;
    letter-spacing: 6px; padding: 6px 20px;
    margin-bottom: 24px; text-transform: uppercase;
  }
  .urgent-stripe {
    position: absolute; top: 0; left: 0; right: 0; height: 12px;
    background: repeating-linear-gradient(
      -45deg, var(--primary) 0, var(--primary) 12px, var(--accent) 12px, var(--accent) 24px
    );
  }
  .playful-dots {
    position: absolute; top: 0; right: 0;
    width: 320px; height: 320px;
    background-image: radial-gradient(circle, var(--accent) 2px, transparent 2px);
    background-size: 28px 28px;
    opacity: 0.15; border-radius: 0 0 0 100%;
  }
  .event-starburst {
    position: absolute; top: -60px; right: -60px;
    width: 280px; height: 280px;
    background: var(--accent);
    opacity: 0.12;
    clip-path: polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);
  }

  /* ── Emoji badge ── */
  .emoji-badge {
    position: absolute; top: 64px; right: 72px;
    font-size: 52px; line-height: 1;
    filter: drop-shadow(0 4px 12px rgba(0,0,0,0.5));
  }

  /* ── Main copy ── */
  .main-copy { flex: 1; display: flex; flex-direction: column; justify-content: center; }

  .eyebrow {
    font-family: var(--font-body); font-size: 16px;
    font-weight: 600; letter-spacing: 5px; text-transform: uppercase;
    color: var(--accent); margin-bottom: 20px;
    opacity: 0.9;
  }

  .headline {
    font-family: var(--font-display);
    font-size: clamp(72px, 9vw, 108px);
    line-height: 0.95;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: ${designMood === 'luxury' ? '2px' : '-1px'};
    color: var(--text);
    margin-bottom: 24px;
    text-shadow: 0 4px 32px rgba(0,0,0,0.5);
  }

  .headline span.highlight {
    color: var(--accent);
    -webkit-text-stroke: ${designMood === 'bold' ? '0' : '0'};
    display: inline;
  }

  .subheadline {
    font-family: var(--font-body);
    font-size: 26px; font-weight: 300; line-height: 1.4;
    color: var(--text); opacity: 0.85;
    margin-bottom: 32px; max-width: 700px;
  }

  .divider {
    width: 80px; height: 4px;
    background: linear-gradient(90deg, var(--primary), var(--accent));
    border-radius: 2px; margin-bottom: 32px;
  }

  .body-text {
    font-size: 20px; line-height: 1.65;
    color: var(--text); opacity: 0.8;
    max-width: 680px; margin-bottom: 40px;
  }

  /* ── Key points ── */
  .key-points { display: flex; flex-direction: column; gap: 14px; margin-bottom: 48px; }
  .key-point {
    display: flex; align-items: center; gap: 14px;
    font-size: 18px; font-weight: 500; color: var(--text); opacity: 0.9;
  }
  .kp-dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--accent); flex-shrink: 0;
    box-shadow: 0 0 10px var(--accent);
  }

  /* ── Tagline ── */
  .tagline-wrap {
    background: ${designMood === 'luxury'
      ? 'linear-gradient(90deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))'
      : 'rgba(255,255,255,0.07)'};
    border-left: 4px solid var(--primary);
    padding: 16px 24px;
    margin-bottom: 44px; max-width: 680px;
    border-radius: 0 8px 8px 0;
    backdrop-filter: blur(10px);
  }
  .tagline {
    font-family: var(--font-display);
    font-size: ${designMood === 'luxury' ? '22px' : '20px'};
    font-style: italic; color: var(--text); opacity: 0.9;
    font-weight: ${designMood === 'luxury' ? '400' : '600'};
  }

  /* ── CTA ── */
  .cta-wrap { display: flex; align-items: center; gap: 28px; }
  .cta-btn {
    display: inline-flex; align-items: center; gap: 10px;
    background: linear-gradient(135deg, var(--primary), ${colorAccent});
    color: #fff; font-family: var(--font-display);
    font-size: 22px; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase;
    padding: 20px 48px; border-radius: 4px;
    box-shadow: 0 8px 32px ${colorPrimary}66;
    white-space: nowrap;
  }
  .cta-arrow { font-size: 20px; }

  /* ── Footer ── */
  .footer {
    display: flex; justify-content: space-between; align-items: flex-end;
    padding-top: 32px;
    border-top: 1px solid rgba(255,255,255,0.12);
  }
  .footer-brand {
    font-family: var(--font-display); font-size: 15px;
    letter-spacing: 4px; text-transform: uppercase;
    color: var(--accent); opacity: 0.7;
  }
  .footer-watermark {
    font-size: 13px; opacity: 0.3; letter-spacing: 2px; text-transform: uppercase;
  }
</style>
</head>
<body>
<div class="flyer">
  ${heroSection}

  ${(moodAccents[designMood] || '')}

  <div class="content">
    <div class="logo-wrap">${logoSection}</div>

    ${suggestedEmoji ? `<div class="emoji-badge">${suggestedEmoji}</div>` : ''}

    <div class="main-copy">
      ${designMood === 'news' ? '<div class="news-banner">BREAKING</div>' : ''}
      <div class="eyebrow">${subheadline || 'Campaign'}</div>
      <h1 class="headline">${headline}</h1>
      <div class="divider"></div>
      <p class="body-text">${bodyText}</p>

      ${keyPoints.length ? `<div class="key-points">${keyPointsHtml}</div>` : ''}

      ${tagline ? `<div class="tagline-wrap"><p class="tagline">"${tagline}"</p></div>` : ''}

      <div class="cta-wrap">
        <div class="cta-btn">${ctaText} <span class="cta-arrow">→</span></div>
      </div>
    </div>

    <div class="footer">
      <div class="footer-brand">${brandName || 'iEndorse'}</div>
      <div class="footer-watermark">Powered by iEndorse</div>
    </div>
  </div>
</div>
</body>
</html>`;
}

/* ============================
   Render HTML → PNG via Puppeteer
============================ */
async function renderFlyerHtmlToPng(htmlContent, outPath) {
  let executablePath;
  let launchArgs;

  const isLambda = !!(process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);

  if (isLambda) {
    // ── Lambda: use @sparticuz/chromium ──────────────────────────────────────
    // This package ships a Chromium binary that actually runs in the Lambda
    // execution environment (Amazon Linux 2, read-only fs except /tmp).
    //
    // Install: npm install @sparticuz/chromium puppeteer-core
    //
    // If your Lambda deployment package exceeds the 50 MB zipped limit,
    // host the Chromium binary on S3 / a Lambda Layer and set:
    //   CHROMIUM_LAYER_PATH=<path to extracted binary>
    // ─────────────────────────────────────────────────────────────────────────
    let chromium;
    try {
      chromium = require('@sparticuz/chromium');
    } catch (e) {
      throw new Error(
        '@sparticuz/chromium is not installed. ' +
        'Run: npm install @sparticuz/chromium puppeteer-core'
      );
    }

    // Allow overriding the binary path via env (useful with Lambda Layers)
    if (process.env.CHROMIUM_LAYER_PATH) {
      chromium.executablePath = async () => process.env.CHROMIUM_LAYER_PATH;
    }

    executablePath = await chromium.executablePath();
    launchArgs     = [
      ...chromium.args,
      '--disable-dev-shm-usage',   // Lambda has no /dev/shm
      '--font-render-hinting=none',
      '--hide-scrollbars',
      '--mute-audio',
    ];

    // Chromium on Lambda needs to write to /tmp
    if (!process.env.HOME) process.env.HOME = '/tmp';

  } else {
    // ── Local / ECS: find Chrome/Chromium the normal way ────────────────────
    const chromePaths = [
      process.env.CHROMIUM_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/local/bin/chromium',
    ].filter(Boolean);

    executablePath = chromePaths.find(p => fs.existsSync(p)) || null;

    if (!executablePath) {
      try {
        const pup = require('puppeteer');
        executablePath = pup.executablePath?.();
      } catch (_) {}
    }

    if (!executablePath) {
      throw new Error(
        'Chromium/Chrome not found locally. ' +
        'Install puppeteer or set CHROMIUM_PATH env var.'
      );
    }

    launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ];
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,   // 'new' flag not supported in older puppeteer-core versions
    args: launchArgs,
    defaultViewport: { width: 1080, height: 1350, deviceScaleFactor: 2 },
  });

  try {
    const page = await browser.newPage();

    // Load HTML — use networkidle2 on Lambda (networkidle0 can timeout waiting
    // for Google Fonts if egress is restricted; fall back gracefully)
    try {
      await page.setContent(htmlContent, { waitUntil: 'networkidle2', timeout: 25000 });
    } catch (_) {
      // If network idle times out (e.g. fonts blocked), continue anyway —
      // the flyer will render with fallback system fonts
      await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 10000 });
    }

    // Wait for fonts
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await new Promise(r => setTimeout(r, isLambda ? 1200 : 800));

    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: { x: 0, y: 0, width: 1080, height: 1350 },
    });
  } finally {
    await browser.close();
  }
}

/* ============================
   FILE → base64
============================ */
async function fileToBase64(filePath) {
  const buf = fs.readFileSync(filePath);
  return buf.toString('base64');
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  return map[ext] || 'image/jpeg';
}

/* ============================
   ROUTE: POST /ai-video/generate-flyer
============================ */
router.post('/ai-video/generate-flyer', upload.none(), async (req, res) => {
  let {
    // --- shared with generate-video ---
    script,
    campaignTitle,
    campaignDescription,
    scriptContext,
    category,
    voice    = 'Ava',
    tone     = 'professional',
    media,           // JSON array of { filePath } — images used as hero / logo
    accountId,

    // --- flyer-specific ---
    flyerStyle,      // "bold" | "minimal" | "luxury" | "news" | "event" | "corporate" | "playful" | "urgent"
    tagline,         // optional override
    ctaText,         // optional override
    colorScheme,     // "auto" | "#FF4500,#1A1A2E"
    logoUrl,         // optional direct logo URL
    heroUrl,         // optional direct hero image URL
  } = req.body;

  if (!accountId) return res.status(400).json({ error: 'accountId is required' });

  tone = String(tone || 'professional').toLowerCase().trim();
  const scriptAsDescription = String(script || '').trim();
  if (scriptAsDescription) campaignDescription = scriptAsDescription;
  else campaignDescription = String(campaignDescription || '').trim();

  if (typeof media === 'string') {
    try { media = JSON.parse(media); } catch { return res.status(400).json({ error: 'media must be valid JSON array' }); }
  }

  const openaiApiKey = req.openai_api_key || process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return res.status(500).json({ error: 'OpenAI key not configured' });

  const tempFiles = [];

  try {
    // ── Wallet check ──
    const pool = getDbPoolFromReq(req);
    const walletRow = await pool.request()
      .input('accountId', sql.Int, parseInt(accountId, 10))
      .query(`SELECT Id, WalletUnits FROM Accounts WHERE Id = @accountId;`);

    if (!walletRow.recordset?.length) return res.status(404).json({ error: 'Account not found.' });
    const currentUnits = walletRow.recordset[0].WalletUnits;
    if (currentUnits < FLYER_COST) {
      return res.status(400).json({
        error: 'Insufficient wallet units.',
        message: `You have ${currentUnits} units but need ${FLYER_COST} units to generate a flyer.`,
        currentWalletUnits: currentUnits, requiredUnits: FLYER_COST,
      });
    }

    // ── Collect media files ──
    const userImages = [];
    const mediaArr = Array.isArray(media) ? media : [];
    for (const m of mediaArr) {
      if (!m?.filePath) continue;
      const local = await downloadFileIfNeeded(m.filePath);
      tempFiles.push(local);
      if (isImagePath(local)) userImages.push(local);
    }

    // Optional direct hero / logo URLs
    if (heroUrl && isUrl(heroUrl)) {
      const local = await downloadFileIfNeeded(heroUrl);
      tempFiles.push(local);
      userImages.unshift(local); // first = hero candidate
    }
    if (logoUrl && isUrl(logoUrl)) {
      const local = await downloadFileIfNeeded(logoUrl);
      tempFiles.push(local);
      userImages.push(local);
    }

    // ── AI: generate copy + design direction ──
    const categorySlug = normalizeCategory(category);
    const flyerContent = await inferFlyerContent({
      apiKey: openaiApiKey,
      scriptText: scriptAsDescription,
      campaignTitle: String(campaignTitle || '').trim(),
      campaignDescription,
      tone, flyerStyle, tagline, ctaText,
      category: categorySlug,
    });

    // Override colors if user supplied a colorScheme
    if (colorScheme && colorScheme !== 'auto') {
      const parts = String(colorScheme).split(',').map(s => s.trim());
      if (parts[0]) flyerContent.colorPrimary = parts[0];
      if (parts[1]) flyerContent.colorBg      = parts[1];
    }

    // ── Encode images to base64 ──
    let heroBase64    = null, heroMimeType    = null;
    let logoBase64    = null, logoMimeType    = null;

    if (userImages.length >= 1) {
      heroBase64  = await fileToBase64(userImages[0]);
      heroMimeType = guessMimeType(userImages[0]);
    }
    if (userImages.length >= 2) {
      logoBase64  = await fileToBase64(userImages[userImages.length - 1]);
      logoMimeType = guessMimeType(userImages[userImages.length - 1]);
    }

    // ── Build HTML ──
    const brandName = flyerContent.brandName
      || String(campaignTitle || '').trim()
      || 'iEndorse';

    const html = buildFlyerHtml({
      content: flyerContent,
      heroBase64, heroMimeType,
      logoBase64, logoMimeType,
      brandName,
    });

    // ── Render to PNG ──
    const flyerId   = uuidv4();
    const outPath   = path.join(TEMP_DIR, `flyer_${flyerId}.png`);
    tempFiles.push(outPath);

    await renderFlyerHtmlToPng(html, outPath);

    // ── Upload to S3 ──
    const flyerUrl = await uploadFlyerToS3(outPath, flyerId);

    // ── Deduct wallet ──
    const { remainingWalletUnits } = await deductWalletUnitsAtomic({
      pool, accountId, cost: FLYER_COST,
    });

    return res.json({
      flyerId,
      flyerUrl,
      downloadUrl: flyerUrl,
      category:   categorySlug,
      flyerStyle: flyerContent.designMood,
      content: {
        headline:    flyerContent.headline,
        subheadline: flyerContent.subheadline,
        tagline:     flyerContent.tagline,
        bodyText:    flyerContent.bodyText,
        ctaText:     flyerContent.ctaText,
        keyPoints:   flyerContent.keyPoints,
      },
      colors: {
        primary: flyerContent.colorPrimary,
        accent:  flyerContent.colorAccent,
        bg:      flyerContent.colorBg,
        text:    flyerContent.colorText,
      },
      walletUnitsDeducted: FLYER_COST,
      remainingWalletUnits,
      outputLocation: { bucket: OUTPUT_BUCKET, prefix: S3_FLYER_PREFIX },
    });

  } catch (err) {
    console.error('[generate-flyer] Error:', err);
    return res.status(500).json({ error: 'Failed to generate campaign flyer', details: err.message });
  } finally {
    tempFiles.forEach(safeUnlink);
  }
});

module.exports = router;