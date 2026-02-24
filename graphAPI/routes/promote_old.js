/**
 * @file promote-campaign.js
 * @description Handles campaign promotion via Facebook and Instagram for the IEndorse platform.
 *
 * Flow overview:
 *  1. Validate incoming request (campaignId, accessToken, promotionPackage, accountId).
 *  2. Resolve the promotion package (bronze/silver/gold/platinum) to a WalletUnits cost.
 *  3. Verify the requesting account has sufficient WalletUnits; deduct them atomically.
 *  4a. If the campaign already has a metaPostId → add an endorsement comment + boost the post.
 *  4b. If no metaPostId → generate AI caption, process media, publish to Facebook & Instagram,
 *      save the returned metaPostId, reset Created to NOW() and CampaignUnit to 1000
 *      so the campaign surfaces on the front-page feed.
 *  5. Return a structured JSON response in all cases.
 *
 * Promotion packages (Naira WalletUnits):
 *   bronze   = 1,500 WalletUnits  (meets Meta's ₦1,363.68 minimum)
 *   silver   = 3,000 WalletUnits
 *   gold     = 5,000 WalletUnits
 *   platinum = 10,000 WalletUnits
 */

'use strict';

const express  = require('express');
const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const sql      = require('mssql');
const multer   = require('multer');
const ffmpeg   = require('fluent-ffmpeg');
const { OpenAI } = require('openai');

// ─── Router bootstrap ────────────────────────────────────────────────────────
const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
const upload = multer();

// ─── Environment / constants ─────────────────────────────────────────────────
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

const PAGE_ID        = process.env.PAGE_ID;
const IG_USER_ID     = process.env.IG_USER_ID;
const AD_ACCOUNT_ID  = process.env.AD_ACCOUNT_ID; // e.g. "act_123456789" — required for boosting
const TEMP_DIR       = path.resolve('temp');

/**
 * Promotion package tiers mapped to their Naira point costs.
 * Pricing accounts for Meta's minimum ad budget (₦1,363.68 in Nigeria).
 * Update these values here if pricing changes — no other code needs to change.
 */
const PROMOTION_PACKAGES = {
    bronze:   1500,   // ₦1,500 (meets Meta minimum)
    silver:   3000,   // ₦3,000 (2x bronze)
    gold:     5000,   // ₦5,000
    platinum: 10000,  // ₦10,000 (2x gold)
};

/**
 * After any successful promotion we reset CampaignUnit to this value and
 * Created to NOW(), which pushes the campaign to the top of the front-page feed.
 */
const FRONTPAGE_CAMPAIGN_UNIT = 1000;

/** Maximum characters we send to OpenAI to stay within token budgets. */
const MAX_CAMPAIGN_TEXT_CHARS = 3000;

// Ensure the temp directory exists at process startup
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });


// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Downloads a remote file (or copies a local one) into the temp directory.
 * The caller is responsible for adding the returned path to `tempFiles` for cleanup.
 *
 * @param {string} filePath - Absolute local path or fully-qualified HTTP(S) URL.
 * @returns {Promise<string>} Resolved local temp path.
 * @throws {Error} If the local file does not exist or the download fails.
 */
async function downloadFileIfNeeded(filePath) {
    if (!filePath) throw new Error('downloadFileIfNeeded: filePath is undefined');

    const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const tempPath = path.join(TEMP_DIR, `${uuidv4()}_${safeName}`);

    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        const response = await axios({ method: 'GET', url: filePath, responseType: 'stream' });
        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(tempPath);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } else {
        if (!fs.existsSync(filePath)) throw new Error(`Local file not found: ${filePath}`);
        fs.copyFileSync(filePath, tempPath);
    }

    return tempPath;
}

/**
 * Converts any image format to PNG using FFmpeg.
 * Forces even pixel dimensions, which is required by most video codecs.
 *
 * @param {string} inputPath  - Source image path.
 * @param {string} outputPath - Destination PNG path.
 * @returns {Promise<string>} outputPath on success.
 */
async function convertImageToPng(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-pix_fmt rgb24',
            ])
            .output(outputPath)
            .on('end',   () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Stitches an ordered array of images into a single MP4 slideshow.
 * Optionally overlays a background audio track; audio is truncated to video length.
 *
 * @param {string[]}    imagePaths      - Ordered list of PNG/JPG source paths.
 * @param {string}      outputVideoPath - Destination MP4 path.
 * @param {number}      [duration=50]   - Total video duration in seconds.
 * @param {string|null} [audioPath]     - Optional path to an audio file.
 * @returns {Promise<string>} outputVideoPath on success.
 */
async function createVideoFromImages(imagePaths, outputVideoPath, duration = 50, audioPath = null) {
    return new Promise((resolve, reject) => {
        if (!imagePaths.length) return reject(new Error('createVideoFromImages: no images provided'));

        // Write an FFmpeg concat demuxer manifest so each image is held for its share of the duration
        const listFile       = path.join(TEMP_DIR, `ffmpeg_list_${uuidv4()}.txt`);
        const durationPerImg = duration / imagePaths.length;

        let listContent = '';
        imagePaths.forEach((img, i) => {
            listContent += `file '${path.resolve(img).replace(/\\/g, '/')}'\n`;
            if (i < imagePaths.length - 1) listContent += `duration ${durationPerImg}\n`;
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
                '-crf 23',      // balanced quality / size (0 = lossless, 51 = worst)
                '-preset slow',
            ]);

        if (audioPath && fs.existsSync(audioPath)) {
            cmd = cmd.input(audioPath).outputOptions(['-shortest']);
        }

        cmd.output(outputVideoPath)
            .on('end',   () => { safeUnlink(listFile); resolve(outputVideoPath); })
            .on('error', (err) => { safeUnlink(listFile); reject(err); })
            .run();
    });
}

/**
 * Extracts one frame per second from a video into a directory.
 * Frames are used purely to give the AI caption generator visual context.
 *
 * @param {string} videoPath - Source video file path.
 * @param {string} frameDir  - Directory to write PNG frames into.
 * @returns {Promise<string[]>} Sorted array of extracted frame paths.
 */
async function extractFramesFromVideo(videoPath, frameDir) {
    if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .output(path.join(frameDir, 'frame_%04d.png'))
            .outputOptions(['-vf fps=1'])
            .on('end', () => {
                const frames = fs.readdirSync(frameDir)
                    .filter(f => f.endsWith('.png'))
                    .sort()
                    .map(f => path.join(frameDir, f));
                resolve(frames);
            })
            .on('error', reject)
            .run();
    });
}

/**
 * Returns a random audio file from the uploads/audio directory.
 * Supports .mp3, .wav, and .m4a formats.
 *
 * @returns {string|null} Absolute path to an audio file, or null if none exist.
 */
function getRandomAudio() {
    const audioDir = path.join(__dirname, '../uploads/audio');
    if (!fs.existsSync(audioDir)) return null;

    const supportedExts = ['.mp3', '.wav', '.m4a'];
    const files = fs.readdirSync(audioDir)
        .filter(f => supportedExts.includes(path.extname(f).toLowerCase()));

    if (!files.length) return null;
    return path.join(audioDir, files[Math.floor(Math.random() * files.length)]);
}

/**
 * Deletes a file if it exists. Silently swallows errors so a cleanup failure
 * never propagates up and masks the real result of a request.
 *
 * @param {string} filePath - Path to the file to delete.
 */
function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        console.warn(`[safeUnlink] Could not delete ${filePath}: ${err.message}`);
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  AI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calls GPT-4 to generate an optimised social media caption and hashtag set
 * for the given campaign. Falls back to raw campaign text on any failure so
 * the post always goes out even if OpenAI is temporarily unavailable.
 *
 * @param {Object} campaign      - Campaign record from the database.
 * @param {string} endorseNote   - Optional endorsement note from the requester.
 * @param {OpenAI} openai        - Initialised OpenAI client instance.
 * @returns {Promise<{ caption: string, hashtags: string[] }>}
 */
async function generateAICaption(campaign, endorseNote, openai) {
    // Assemble and truncate campaign text to stay within the model's context budget
    let campaignText = [
        campaign.CampaignTitle,
        campaign.CampaignDescription,
        endorseNote || '',
    ].join('\n').trim();

    if (campaignText.length > MAX_CAMPAIGN_TEXT_CHARS) {
        campaignText = campaignText.slice(0, MAX_CAMPAIGN_TEXT_CHARS);
    }

    const prompt = `You are a professional AI content strategist for IEndorse, a social endorsement platform.
Generate an optimised, engaging social media caption for the campaign below.
Respond ONLY with valid JSON — no extra text, no markdown fences.

Format:
{
  "caption": "engaging caption text here",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3"]
}

Campaign Info:
${campaignText}`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: 'You are a professional AI content strategist. Always respond with valid JSON only.' },
                { role: 'user',   content: prompt },
            ],
            max_tokens:  400,
            temperature: 0.7,
        });

        const raw    = response?.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(raw);

        if (!parsed.caption || typeof parsed.caption !== 'string') {
            throw new Error('Missing or invalid caption field in AI response');
        }

        return {
            caption:  parsed.caption.trim(),
            hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
        };

    } catch (err) {
        console.warn(`[generateAICaption] AI failed — using raw text fallback. Reason: ${err.message}`);
        return {
            caption:  `${campaign.CampaignTitle} – ${campaign.CampaignDescription}`.slice(0, 300),
            hashtags: ['#iEndorse'],
        };
    }
}

/**
 * Calls GPT-4 to generate five authentic engagement comments for the post.
 * Each comment is under 30 words with a professional, thought-leader tone.
 * Returns an empty array on failure (comments are non-critical to the flow).
 *
 * @param {Object} campaign    - Campaign record from the database.
 * @param {string} postMessage - The fully assembled post message.
 * @param {OpenAI} openai      - Initialised OpenAI client instance.
 * @returns {Promise<string[]>} Array of comment strings.
 */
async function generateAIComments(campaign, postMessage, openai) {
    const prompt = `You are an AI social media engagement assistant for IEndorse.
Generate 5 unique, positive comments (each under 30 words) about the post below.
Respond ONLY with valid JSON — no extra text, no markdown fences.

Format:
{
  "comments": ["comment1", "comment2", "comment3", "comment4", "comment5"]
}

Campaign Title: ${campaign.CampaignTitle}
Campaign Description: ${campaign.CampaignDescription}
Post Message: ${postMessage}

Requirements:
- Each comment must be unique and relevant to the content
- Professional, thought-leader tone
- Under 30 words each
- Sound authentic — avoid repetitive phrases or generic praise`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                { role: 'system', content: 'You are a professional social media engagement specialist. Always respond with valid JSON only.' },
                { role: 'user',   content: prompt },
            ],
            max_tokens:  500,
            temperature: 0.8,
        });

        const content = response?.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty response from OpenAI');

        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed.comments)) throw new Error('Response missing comments array');

        return parsed.comments
            .filter(c => c && typeof c === 'string' && c.trim().length > 0)
            .map(c => c.trim());

    } catch (err) {
        // Non-fatal — AI comments enhance the post but are not required for success
        console.warn(`[generateAIComments] Failed to generate comments. Reason: ${err.message}`);
        return [];
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  INSTAGRAM HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Publishes a single image or Reel to Instagram via the Meta Graph API.
 * Uses the required two-step container-create → publish flow.
 * For Reels, inserts a 60-second delay to allow Meta's encoding pipeline to finish.
 *
 * @param {string} mediaUrl    - Publicly accessible URL of the media asset.
 * @param {string} caption     - Post caption text.
 * @param {string} accessToken - Page/User access token with instagram_basic and publish_video scopes.
 * @returns {Promise<string>}  Instagram media ID of the published post.
 * @throws {Error}             If IG_USER_ID is not configured or the API calls fail.
 */
async function postToInstagram(mediaUrl, caption, accessToken) {
    if (!IG_USER_ID) throw new Error('IG_USER_ID environment variable is not set');

    const isVideo   = /\.(mp4|mov|avi)$/i.test(mediaUrl);
    const mediaType = isVideo ? 'REELS' : 'IMAGE';

    // ── Step 1: Create media container ──────────────────────────────────────
    const containerRes = await axios.post(
        `https://graph.facebook.com/v21.0/${IG_USER_ID}/media`,
        null,
        {
            params: {
                access_token: accessToken,
                caption,
                ...(mediaType === 'IMAGE'
                    ? { image_url: mediaUrl }
                    : { media_type: 'REELS', video_url: mediaUrl }),
            },
        }
    );

    const creationId = containerRes.data.id;
    console.log(`[Instagram] Container created: ${creationId} (${mediaType})`);

    // ── Step 2: Wait for Reel encoding ──────────────────────────────────────
    if (mediaType === 'REELS') {
        console.log('[Instagram] Waiting 60s for Reel encoding to complete...');
        await new Promise(r => setTimeout(r, 60_000));
    }

    // ── Step 3: Publish the container ───────────────────────────────────────
    const publishRes = await axios.post(
        `https://graph.facebook.com/v21.0/${IG_USER_ID}/media_publish`,
        null,
        { params: { access_token: accessToken, creation_id: creationId } }
    );

    const igMediaId = publishRes.data.id;
    console.log(`[Instagram] Published. Media ID: ${igMediaId}`);

    // ── Step 4: Update caption (required for Reels; safe no-op for images) ──
    if (caption) {
        await axios.post(
            `https://graph.facebook.com/v21.0/${igMediaId}`,
            null,
            { params: { access_token: accessToken, caption, comment_enabled: true } }
        );
        console.log(`[Instagram] Caption updated for media ID: ${igMediaId}`);
    }

    return igMediaId;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN ROUTE:  POST /promote-campaign
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/promote-campaign', upload.none(), async (req, res) => {

    // ── 1. Parse and validate all incoming parameters ────────────────────────
    const campaignId       = Number(req.body.campaignId      || req.query.campaignId);
    const accountId        = Number(req.body.accountId       || req.query.accountId);
    const accessToken      = req.accessToken || req.body.accessToken || req.query.accessToken;
    const endorsementNote  = (req.body.endorsementNote       || req.query.endorsementNote  || '').trim();
    const promotionPackage = (req.body.promotionPackage      || req.query.promotionPackage || '').toLowerCase().trim();
    const OPENAI_API_KEY   = req.openai_api_key;

    if (!campaignId) {
        return res.status(400).json({ error: 'Missing required parameter: campaignId' });
    }
    if (!accountId) {
        return res.status(400).json({ error: 'Missing required parameter: accountId' });
    }
    if (!accessToken) {
        return res.status(400).json({ error: 'Missing required parameter: accessToken' });
    }
    if (!PAGE_ID) {
        return res.status(500).json({ error: 'Server misconfiguration: PAGE_ID environment variable not set' });
    }
    if (!OPENAI_API_KEY) {
        return res.status(500).json({ error: 'Server misconfiguration: OpenAI API key not available' });
    }

    // Validate promotion package against known tiers
    if (!PROMOTION_PACKAGES[promotionPackage]) {
        return res.status(400).json({
            error: `Invalid promotionPackage "${promotionPackage}". ` +
                   `Must be one of: ${Object.keys(PROMOTION_PACKAGES).join(', ')}`,
            packages: PROMOTION_PACKAGES,
        });
    }

    const packageCost = PROMOTION_PACKAGES[promotionPackage]; // Naira WalletUnits to deduct

    // ── 2. Initialise shared resources ──────────────────────────────────────
    const pool   = req.app.locals.db;
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    if (!pool) {
        return res.status(500).json({ error: 'Database connection is not available' });
    }

    // All temp files collected here so the finally block can clean them up
    // regardless of whether the request succeeds or throws mid-flight.
    const tempFiles = [];

    try {

        // ────────────────────────────────────────────────────────────────────
        // STEP A: Verify the account exists and has sufficient WalletUnits
        // ────────────────────────────────────────────────────────────────────
        const accountResult = await pool.request()
            .input('accountId', sql.Int, accountId)
            .query(`
                SELECT Id, FullName, EmailAddress, WalletUnits
                FROM   Accounts
                WHERE  Id = @accountId
            `);

        if (!accountResult.recordset.length) {
            return res.status(404).json({ error: `Account not found: ID ${accountId}` });
        }

        const account        = accountResult.recordset[0];
        const currentWalletUnits  = Number(account.WalletUnits) || 0;

        if (currentWalletUnits < packageCost) {
            return res.status(402).json({
                error:           'Insufficient WalletUnits for the selected promotion package',
                promotionPackage,
                packageCost,
                available:       currentWalletUnits,
                shortfall:       packageCost - currentWalletUnits,
                message:         `The ${promotionPackage} package costs ${packageCost.toLocaleString()} WalletUnits. ` +
                                 `Account has ${currentWalletUnits.toLocaleString()} WalletUnits ` +
                                 `(${(packageCost - currentWalletUnits).toLocaleString()} short).`,
            });
        }

        // ────────────────────────────────────────────────────────────────────
        // STEP B: Atomically deduct WalletUnits from the account
        //
        // The WHERE clause re-checks the live balance to protect against a
        // race condition where two concurrent requests drain the same account.
        // If rowsAffected is 0 the balance dropped between STEP A and now,
        // so we respond with 409 Conflict rather than silently over-spending.
        // ────────────────────────────────────────────────────────────────────
        const deductResult = await pool.request()
            .input('packageCost', sql.Int, packageCost)
            .input('accountId',   sql.Int, accountId)
            .query(`
                UPDATE Accounts
                SET    WalletUnits = WalletUnits - @packageCost
                WHERE  Id     = @accountId
                  AND  WalletUnits >= @packageCost
            `);

        if (deductResult.rowsAffected[0] === 0) {
            // Race condition: balance was sufficient when we checked (STEP A)
            // but another request consumed WalletUnits before this UPDATE committed.
            return res.status(409).json({
                error:   'Point balance changed during processing. Please retry.',
                required: packageCost,
            });
        }

        console.log(
            `[Promotion] Deducted ${packageCost.toLocaleString()} WalletUnits from ` +
            `Account ${accountId} (${account.FullName}). Package: ${promotionPackage}. ` +
            `Remaining: ${(currentWalletUnits - packageCost).toLocaleString()}`
        );

        // ────────────────────────────────────────────────────────────────────
        // STEP C: Fetch campaign record (includes metaPostId)
        // ────────────────────────────────────────────────────────────────────
        const campaignResult = await pool.request()
            .input('campaignId', sql.Int, campaignId)
            .query(`
                SELECT
                    c.Id             AS CampaignId,
                    c.CampaignTitle,
                    c.Description    AS CampaignDescription,
                    c.CampaignUnit,
                    c.CampaignLink,
                    c.metaPostId,
                    c.adCampaignId,
                    c.adSetId,
                    cat.CategoryName AS CampaignCategory,
                    a.FullName       AS CampaignOwnerName,
                    a.EmailAddress   AS CampaignOwnerEmail
                FROM   Campaigns  c
                INNER JOIN Categories cat ON c.CategoryId = cat.Id
                INNER JOIN Accounts   a   ON c.AccountId  = a.Id
                WHERE  c.Id = @campaignId
            `);

        if (!campaignResult.recordset.length) {
            return res.status(404).json({ error: `Campaign not found: ID ${campaignId}` });
        }

        const campaign          = campaignResult.recordset[0];
        const existingMetaPostId = campaign.metaPostId;


        // ════════════════════════════════════════════════════════════════════
        //  PATH 1 ── Campaign already has a metaPostId
        //            Add an endorsement comment and boost the existing post.
        // ════════════════════════════════════════════════════════════════════
        if (existingMetaPostId) {
            console.log(
                `[Promotion] Campaign ${campaignId} already posted. ` +
                `metaPostId: ${existingMetaPostId}. Adding comment + boost.`
            );

            // ── Build endorsement comment ────────────────────────────────────
            // Include the package tier and unit value so it appears on the post.
            const endorsementComment = endorsementNote
                ? `✅ Endorsed via iEndorse (${promotionPackage} · ${packageCost.toLocaleString()} WalletUnits): ${endorsementNote}`
                : `✅ Endorsed via iEndorse with a ${promotionPackage} package (${packageCost.toLocaleString()} WalletUnits).`;

            // ── Post the comment on Facebook ─────────────────────────────────
            try {
                await axios.post(
                    `https://graph.facebook.com/v19.0/${existingMetaPostId}/comments`,
                    { message: endorsementComment },
                    { params: { access_token: accessToken } }
                );
                console.log(`[Facebook] Endorsement comment posted on ${existingMetaPostId}`);
            } catch (commentErr) {
                // Non-fatal: log the failure but do not reverse the promotion
                console.error(
                    `[Facebook] Failed to post comment on ${existingMetaPostId}:`,
                    commentErr.response?.data || commentErr.message
                );
            }

            // ── Boost the existing post via Meta Ads API (budget pooling) ───
            //
            // BUDGET POOLING: Instead of creating duplicate ad campaigns, we:
            //   1. Check if campaign.adSetId exists (ongoing boost)
            //   2. If YES → increase the existing Ad Set's lifetime_budget
            //   3. If NO  → create Campaign → AdSet → Ad (3-step flow)
            //
            // This way 10 bronze endorsements = ONE campaign with pooled budget,
            // not 10 competing campaigns.
            //
            // Budget: 1 WalletUnit = ₦1. Meta expects lifetime_budget in kobo
            // (smallest NGN unit), so multiply by 100.
            // ──────────────────────────────────────────────────────────────────
            if (!AD_ACCOUNT_ID) {
                console.warn('[Facebook] AD_ACCOUNT_ID env var not set — skipping boost.');
            } else {
                const boostBudgetKobo = packageCost * 100; // ₦1 = 100 kobo

                try {
                    // ── PATH A: Active ad set exists → increase budget ──────────
                    if (campaign.adSetId) {
                        console.log(
                            `[Facebook] Ad Set ${campaign.adSetId} already exists. ` +
                            `Increasing budget by ₦${packageCost.toLocaleString()}...`
                        );

                        // Fetch current lifetime_budget from the Ad Set
                        const adSetRes = await axios.get(
                            `https://graph.facebook.com/v19.0/${campaign.adSetId}`,
                            { params: { access_token: accessToken, fields: 'lifetime_budget,end_time' } }
                        );

                        const currentBudgetKobo = Number(adSetRes.data.lifetime_budget) || 0;
                        const newBudgetKobo     = currentBudgetKobo + boostBudgetKobo;

                        // Extend end_time based on package tier
                        const BOOST_DAYS = { bronze: 1, silver: 2, gold: 3, platinum: 5 };
                        const extendBySec = (BOOST_DAYS[promotionPackage] || 1) * 86400;
                        const currentEndSec = Number(adSetRes.data.end_time) || Math.floor(Date.now() / 1000) + 86400;
                        const newEndSec = currentEndSec + extendBySec;

                        // Update the Ad Set
                        await axios.post(
                            `https://graph.facebook.com/v19.0/${campaign.adSetId}`,
                            null,
                            {
                                params: {
                                    access_token:    accessToken,
                                    lifetime_budget: newBudgetKobo,
                                    end_time:        newEndSec,
                                },
                            }
                        );

                        console.log(
                            `[Facebook] Ad Set ${campaign.adSetId} budget increased. ` +
                            `Previous: ₦${(currentBudgetKobo / 100).toLocaleString()}, ` +
                            `New: ₦${(newBudgetKobo / 100).toLocaleString()}, ` +
                            `Extended by ${BOOST_DAYS[promotionPackage] || 1} day(s)`
                        );

                    // ── PATH B: No ad set yet → create full Campaign/AdSet/Ad ────
                    } else {
                        console.log(`[Facebook] No active ad set found. Creating new boost campaign...`);

                        // Duration: map package tier to number of boost days
                        const BOOST_DAYS = { bronze: 1, silver: 2, gold: 3, platinum: 5 };
                        const boostDays  = BOOST_DAYS[promotionPackage] || 1;

                        const nowSec = Math.floor(Date.now() / 1000);
                        const endSec = nowSec + boostDays * 86400;

                        // ── Step 1: Create an Ad Campaign ────────────────────────
                        const campaignRes = await axios.post(
                            `https://graph.facebook.com/v19.0/${AD_ACCOUNT_ID}/campaigns`,
                            null,
                            {
                                params: {
                                    access_token:          accessToken,
                                    name:                  `iEndorse Boost – Campaign ${campaignId} – ${campaign.CampaignTitle}`,
                                    objective:             'OUTCOME_ENGAGEMENT',
                                    status:                'ACTIVE',
                                    special_ad_categories: '[]',
                                },
                            }
                        );

                        const adCampaignId = campaignRes.data.id;
                        console.log(`[Facebook] Ad Campaign created: ${adCampaignId}`);

                        // ── Step 2: Create an Ad Set ─────────────────────────────
                        const adSetRes = await axios.post(
                            `https://graph.facebook.com/v19.0/${AD_ACCOUNT_ID}/adsets`,
                            null,
                            {
                                params: {
                                    access_token:      accessToken,
                                    name:              `iEndorse AdSet – ${campaign.CampaignTitle}`,
                                    campaign_id:       adCampaignId,
                                    targeting:         JSON.stringify({
                                        geo_locations: { countries: ['NG'] },
                                        age_min:       18,
                                        age_max:       65,
                                    }),
                                    optimization_goal: 'POST_ENGAGEMENT',
                                    billing_event:     'IMPRESSIONS',
                                    bid_strategy:      'LOWEST_COST_WITHOUT_CAP',  // Required since 2024
                                    lifetime_budget:   boostBudgetKobo,
                                    start_time:        nowSec,
                                    end_time:          endSec,
                                    status:            'ACTIVE',
                                },
                            }
                        );

                        const adSetId = adSetRes.data.id;
                        console.log(`[Facebook] Ad Set created: ${adSetId}`);

                        // ── Step 3: Create the Ad (link to existing page post) ───
                        // Ensure object_story_id is in correct PAGE_ID_POST_ID format
                        const objectStoryId = existingMetaPostId.includes('_')
                            ? existingMetaPostId  // Already has page prefix
                            : `${PAGE_ID}_${existingMetaPostId}`;  // Add page prefix

                        const adRes = await axios.post(
                            `https://graph.facebook.com/v19.0/${AD_ACCOUNT_ID}/ads`,
                            null,
                            {
                                params: {
                                    access_token: accessToken,
                                    name:         `iEndorse Ad – ${campaign.CampaignTitle}`,
                                    adset_id:     adSetId,
                                    creative:     JSON.stringify({
                                        object_story_id: objectStoryId,
                                    }),
                                    status:       'ACTIVE',
                                },
                            }
                        );

                        const adId = adRes.data.id;
                        console.log(
                            `[Facebook] Post ${existingMetaPostId} boosted successfully. ` +
                            `Ad ID: ${adId} | Budget: ₦${packageCost.toLocaleString()} | Days: ${boostDays}`
                        );

                        // ── Persist adCampaignId and adSetId in the database ─────
                        await pool.request()
                            .input('adCampaignId', sql.NVarChar, adCampaignId)
                            .input('adSetId',      sql.NVarChar, adSetId)
                            .input('campaignId',   sql.Int,      campaignId)
                            .query(`
                                UPDATE Campaigns
                                SET    adCampaignId = @adCampaignId,
                                       adSetId      = @adSetId
                                WHERE  Id = @campaignId
                            `);

                        console.log(
                            `[DB] Stored Ad Campaign ID ${adCampaignId} and Ad Set ID ${adSetId} ` +
                            `for campaign ${campaignId}`
                        );
                    }

                } catch (boostErr) {
                    // Non-fatal: boost failure must not reverse endorsement or WalletUnits deduction
                    console.error(
                        `[Facebook] Boost failed for post ${existingMetaPostId}:`,
                        boostErr.response?.data || boostErr.message
                    );
                }
            }

            // ── Refresh campaign front-page ranking ──────────────────────────
            // Every promotion resets Created to NOW() and CampaignUnit to
            // FRONTPAGE_CAMPAIGN_UNIT so the campaign re-surfaces at the top of
            // the discovery feed.
            await pool.request()
                .input('campaignUnit', sql.Int, FRONTPAGE_CAMPAIGN_UNIT)
                .input('campaignId',   sql.Int, campaignId)
                .query(`
                    UPDATE Campaigns
                    SET    CampaignUnit = @campaignUnit,
                           Created      = GETDATE()
                    WHERE  Id = @campaignId
                `);

            console.log(
                `[DB] Campaign ${campaignId} refreshed — ` +
                `CampaignUnit: ${FRONTPAGE_CAMPAIGN_UNIT}, Created: NOW()`
            );

            return res.status(200).json({
                success:          true,
                action:           'comment_and_boost',
                metaPostId:       existingMetaPostId,
                promotionPackage,
                packageCost,
                walletUnitsRemaining:  currentWalletUnits - packageCost,
                accountId,
                accountName:      account.FullName,
                endorsementNote:  endorsementNote || null,
            });
        }


        // ════════════════════════════════════════════════════════════════════
        //  PATH 2 ── No metaPostId yet
        //            Build and publish a brand-new campaign post.
        // ════════════════════════════════════════════════════════════════════

        // ── Fetch all media files associated with this campaign ──────────────
        const filesResult = await pool.request()
            .input('campaignId', sql.Int, campaignId)
            .query(`
                SELECT FilePath, FileType
                FROM   CampaignFiles
                WHERE  CampaignId = @campaignId
            `);

        if (!filesResult.recordset.length) {
            return res.status(400).json({ error: 'Campaign has no associated media files' });
        }

        // ── Download all campaign media to the temp directory ────────────────
        const downloadedPaths = [];
        const fileTypes       = [];

        for (const file of filesResult.recordset) {
            const tmpPath = await downloadFileIfNeeded(file.FilePath);
            tempFiles.push(tmpPath);
            downloadedPaths.push(tmpPath);
            fileTypes.push((file.FileType || '').toLowerCase());
        }

        // Classify each downloaded file as an image or a video
        const imageKeywords = ['image', 'jpg', 'jpeg', 'png', 'gif', 'webp'];
        const videoKeywords = ['video', 'mp4', 'mov', 'avi', 'mkv'];

        const imagePaths = downloadedPaths.filter((_, i) =>
            imageKeywords.some(kw => fileTypes[i].includes(kw))
        );
        const videoPaths = downloadedPaths.filter((_, i) =>
            videoKeywords.some(kw => fileTypes[i].includes(kw))
        );

        // If the campaign has a video, extract frames to give the AI richer context
        if (videoPaths.length > 0) {
            const frameDir   = path.join(TEMP_DIR, `frames_${uuidv4()}`);
            const framePaths = await extractFramesFromVideo(videoPaths[0], frameDir);
            tempFiles.push(...framePaths);
            imagePaths.push(...framePaths); // frames are used for AI context only
        }

        // ── Generate AI caption and hashtags ─────────────────────────────────
        const aiContent = await generateAICaption(campaign, endorsementNote, openai);

        // ── Assemble the final post message ──────────────────────────────────
        const postMessage = [
            aiContent.caption,
            `Link: ${campaign.CampaignLink}`,
            aiContent.hashtags.join(' '),
        ].filter(Boolean).join('\n');

        // ── Process media into the appropriate format for Facebook ───────────
        //
        //   • Video present      → use first video directly
        //   • Multiple images    → convert to PNG, stitch into slideshow MP4 with audio
        //   • Single image       → post as a static photo
        //
        let finalMediaPath = null;
        let isVideo        = false;

        if (videoPaths.length > 0) {
            // Use the uploaded video as-is
            finalMediaPath = videoPaths[0];
            isVideo        = true;

        } else if (imagePaths.length > 1) {
            // Convert each image to PNG first (normalises format/dimensions)
            const convertedPNGs = [];
            for (let i = 0; i < imagePaths.length; i++) {
                const pngPath = path.join(TEMP_DIR, `conv_${i}_${uuidv4()}.png`);
                await convertImageToPng(imagePaths[i], pngPath);
                tempFiles.push(pngPath);
                convertedPNGs.push(pngPath);
            }

            const audioPath = getRandomAudio();
            finalMediaPath  = path.join(TEMP_DIR, `campaign_${campaignId}_${uuidv4()}.mp4`);
            tempFiles.push(finalMediaPath);
            await createVideoFromImages(convertedPNGs, finalMediaPath, 50, audioPath);
            isVideo = true;

        } else {
            // Single image — post as a static photo
            finalMediaPath = imagePaths[0] || downloadedPaths[0];
            isVideo        = false;
        }

        // ── Upload the media to Facebook ─────────────────────────────────────
        console.log(`[Facebook] Uploading ${isVideo ? 'video' : 'photo'} for campaign ${campaignId}...`);

        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('source', fs.createReadStream(finalMediaPath));
        // Facebook uses 'description' for videos and 'message' for photos
        formData.append(isVideo ? 'description' : 'message', postMessage);

        const fbEndpoint = `https://graph-video.facebook.com/v19.0/${PAGE_ID}/${isVideo ? 'videos' : 'photos'}`;

        const fbResp = await axios.post(fbEndpoint, formData, {
            headers:          formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength:    Infinity,
        });

        const newMetaPostId = fbResp.data.id;
        console.log(`[Facebook] Post created. Meta Post ID: ${newMetaPostId}`);

        // ── Persist metaPostId and push campaign to front-page feed ──────────
        //
        // Setting Created = GETDATE() and CampaignUnit = FRONTPAGE_CAMPAIGN_UNIT
        // causes the campaign to sort to the top of the front-page discovery feed.
        // metaPostId is stored so subsequent promotions take PATH 1 instead.
        //
        await pool.request()
            .input('metaPostId',   sql.NVarChar, newMetaPostId)
            .input('campaignUnit', sql.Int,      FRONTPAGE_CAMPAIGN_UNIT)
            .input('campaignId',   sql.Int,      campaignId)
            .query(`
                UPDATE Campaigns
                SET    metaPostId   = @metaPostId,
                       CampaignUnit = @campaignUnit,
                       Created      = GETDATE()
                WHERE  Id = @campaignId
            `);

        console.log(
            `[DB] Campaign ${campaignId} updated — ` +
            `metaPostId: ${newMetaPostId}, CampaignUnit: ${FRONTPAGE_CAMPAIGN_UNIT}, Created: NOW()`
        );

        // ── Post AI engagement comments on the new Facebook post ─────────────
        const aiComments = await generateAIComments(campaign, postMessage, openai);

        for (const comment of aiComments) {
            try {
                await axios.post(
                    `https://graph.facebook.com/v19.0/${newMetaPostId}/comments`,
                    { message: comment },
                    { params: { access_token: accessToken } }
                );
            } catch (commentErr) {
                // Non-fatal: a failed comment should not roll back the whole post
                console.error(
                    `[Facebook] Failed to post AI comment:`,
                    commentErr.response?.data || commentErr.message
                );
            }
        }

        // ── Publish to Instagram (non-fatal if it fails) ─────────────────────
        // Uses the first file's original public URL so Instagram can fetch it
        // directly (temp files are local and not publicly reachable).
        let igMediaId = null;
        try {
            const igMediaUrl = filesResult.recordset[0].FilePath;
            igMediaId = await postToInstagram(igMediaUrl, postMessage, accessToken);
        } catch (igErr) {
            // Instagram failure must NOT roll back the Facebook post or DB changes
            console.error('[Instagram] Failed to publish:', igErr.response?.data || igErr.message);
        }

        // ── Return success ────────────────────────────────────────────────────
        return res.status(200).json({
            success:          true,
            action:           'new_post',
            metaPostId:       newMetaPostId,
            postType:         isVideo ? 'video' : 'image',
            promotionPackage,
            packageCost,
            walletUnitsRemaining:  currentWalletUnits - packageCost,
            accountId,
            accountName:      account.FullName,
            endorsementNote:  endorsementNote || null,
            instagramMediaId: igMediaId,
            aiComments,
            message:          postMessage,
        });

    } catch (err) {
        // Unexpected / unrecoverable errors — logged with full context
        console.error(
            `[promote-campaign] Unhandled error — campaignId: ${campaignId}, ` +
            `accountId: ${accountId}, package: ${promotionPackage}:`,
            err
        );
        return res.status(500).json({
            error:   'Failed to process campaign promotion',
            details: err.message,
        });

    } finally {
        // Always clean up every temp file, even if we threw mid-stream
        tempFiles.forEach(f => safeUnlink(f));
    }
});

module.exports = router;