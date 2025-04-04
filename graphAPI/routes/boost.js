// routes/boost.js (or rename the file appropriately, e.g., facebookActions.js)

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os'); // Import os module
const { v4: uuidv4 } = require('uuid');
const sql = require('mssql');

const router = express.Router();
const multer = require('multer');

// --- Middleware (Consider if already applied globally in app.js) ---
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// --- Environment Variables ---
const pageId = process.env.PAGE_ID;
const adAccountId = process.env.AD_ACCOUNT_ID; // Ensure this includes 'act_' prefix if needed by API structure, but typically passed without it
const API_VERSION = 'v22.0'; // Define API version globally
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;
// --- DynamoDB Setup ---
const AWS = require('aws-sdk');
AWS.config.update({
    region: process.env.AWS_REGION || 'us-east-1', // Use env var or default
    // Credentials should ideally be handled by IAM roles or environment variables
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = 'FacebookPosts'; // Or your actual table name

// --- Helper Functions ---

async function savePostRecord(postData) { // Renamed from createPost for clarity
    const params = {
        TableName: TABLE_NAME,
        Item: postData,
    };
    try {
        await dynamoDB.put(params).promise();
        console.log('Post record saved successfully in DynamoDB.');
    } catch (error) {
        console.error('Error saving post record to DynamoDB:', error);
        // Decide if this error should halt the process or just be logged
        // throw error; // Re-throw if saving is critical
    }
}

// --- NEW FUNCTION: Create Ad using Marketing API ---
async function createFacebookAdForPost(config) {
    const {
        postId, // The ID of the Page post (mediaId from photo/video upload)
        pageId, // The ID of the Facebook Page
        budget, // Total budget for the duration
        durationDays, // Duration in days
        accessToken,
        adAccountId, // Should be just the number, e.g., 123456789
        campaignName, // Optional name for the campaign
        targeting // Targeting object (we'll use the simple one for now)
    } = config;

    
    const fullAdAccountId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;

    console.log(`Starting Ad Creation for Post ID: ${postId} on Page ID: ${pageId}`);
    console.log(`Using Ad Account: ${fullAdAccountId}`);

    try {
        // --- 1. Create Campaign ---
        console.log("Creating Ad Campaign...");
        const campaignData = {
            name: campaignName || `Campaign for Post ${postId} - ${new Date().toISOString()}`,
            objective: 'OUTCOME_ENGAGEMENT', // Objective for boosting posts
            status: 'ACTIVE',
            special_ad_categories: ['NONE'], // Adjust if it falls into Housing, Credit, Employment, etc.
            access_token: accessToken,
        };
        const campaignResponse = await axios.post(`${BASE_URL}/${fullAdAccountId}/campaigns`, campaignData);
        const campaignId = campaignResponse.data.id;
        console.log(`Ad Campaign Created: ID = ${campaignId}`);

        // --- 2. Create Ad Set ---
       

        console.log("Creating Ad Set...");
        const now = new Date();
        const startTime = now.toISOString();
        const endTime = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
        const lifetimeBudget = Math.round(budget * 100); // Budget in cents
        console.log("Budget  :",  lifetimeBudget)
        const adSetData = {
            name: `Ad Set for Post ${postId}`,
            campaign_id: campaignId,
            status: 'ACTIVE',
            optimization_goal: 'POST_ENGAGEMENT', // Align with campaign objective
            billing_event: 'IMPRESSIONS', // Common billing event
            bid_strategy: 'LOWEST_COST_WITHOUT_CAP', // Or other strategy
            lifetime_budget: lifetimeBudget,
            start_time: startTime,
            end_time: endTime,
            targeting: { // Structure for Marketing API
                geo_locations: targeting.geo_locations, // Assumes structure { countries: ['NG'] }
                age_min: targeting.age_min,
                age_max: targeting.age_max,
                // Required for Page Post Engagement: Specify publisher platforms and feeds
                publisher_platforms: ['facebook', 'instagram'], // Or just 'facebook' if preferred
                facebook_positions: ['feed'], // Or specific feeds like 'feed', 'instant_article', etc.
                 instagram_positions: ['stream'] // Example for Instagram feed
            },
            access_token: accessToken,
        };
        const adSetResponse = await axios.post(`${BASE_URL}/${fullAdAccountId}/adsets`, adSetData);
        const adSetId = adSetResponse.data.id;
        console.log(`Ad Set Created: ID = ${adSetId}`);

        // --- 3. Create Ad ---
        console.log("Creating Ad...");
        const adData = {
            name: `Ad for Post ${postId}`,
            adset_id: adSetId,
            status: 'ACTIVE',
            creative: {
                // Use object_story_id to link to an existing page post
                object_story_id: `${pageId}_${postId}` // Combine Page ID and Post ID
            },
            access_token: accessToken,
        };
        const adResponse = await axios.post(`${BASE_URL}/${fullAdAccountId}/ads`, adData);
        const adId = adResponse.data.id;
        console.log(`Ad Created: ID = ${adId}`);

        console.log('Ad Creation Process Completed Successfully.');
        return {
            success: true,
            campaign_id: campaignId,
            ad_set_id: adSetId,
            ad_id: adId,
        };

    } catch (error) {
        console.error('Error during Facebook Ad creation:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Throw a more specific error
        const errorMessage = error.response?.data?.error?.message || error.message;
        const errorCode = error.response?.data?.error?.code;
        const errorSubcode = error.response?.data?.error?.error_subcode;
        throw new Error(`Failed to create Facebook Ad: ${errorMessage} (Code: ${errorCode}, Subcode: ${errorSubcode})`);
    }
}


// --- Function to download file (Improved Temp Path) ---
async function downloadFileIfNeeded(filePath) {
    if (!filePath) {
        throw new Error('File path is undefined or null');
    }

    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        console.log(`Downloading remote file: ${filePath}`);
        try {
            const response = await axios({
                method: 'get',
                url: filePath,
                responseType: 'stream'
            });

            // Use OS temporary directory and unique filename
            const tempDir = os.tmpdir();
            const uniqueSuffix = uuidv4();
            // Sanitize basename to avoid issues with invalid characters if any
            const safeBaseName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
            const tempFilePath = path.join(tempDir, `download_${uniqueSuffix}_${safeBaseName}`);
            console.log(`Saving temporary file to: ${tempFilePath}`);

            // Ensure temp directory exists (it usually does, but good practice)
            // await fs.promises.mkdir(tempDir, { recursive: true }); // fs.promises requires Node 10+

            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                     console.log(`File downloaded successfully to ${tempFilePath}`);
                     resolve(tempFilePath);
                });
                writer.on('error', (err) => {
                    console.error(`Error writing temporary file ${tempFilePath}:`, err);
                    // Attempt cleanup on error
                    fs.unlink(tempFilePath, () => {}); // Non-critical cleanup attempt
                    reject(err);
                });
                 response.data.on('error', (err) => { // Handle stream read errors
                     console.error(`Error reading download stream from ${filePath}:`, err);
                      writer.close(); // Close writer if read fails
                      fs.unlink(tempFilePath, () => {}); // Non-critical cleanup attempt
                     reject(err);
                 });
            });
        } catch (error) {
            console.error(`Error downloading file from ${filePath}:`, error.message);
            if (error.response) {
                console.error('Download error status:', error.response.status);
                console.error('Download error headers:', error.response.headers);
            }
            throw error; // Re-throw the error
        }
    } else {
        console.log(`Using local file path: ${filePath}`);
        // If it's a local path, just return it (ensure it exists later)
        return filePath;
    }
}

// --- Main Endpoint ---
const upload = multer(); // For handling form-data fields if needed, but mainly using JSON here

router.post('/boost-campaign', upload.none(), async (req, res) => { // upload.none() if primarily using JSON/URL-encoded
    console.log('================= NEW REQUEST =================');
    console.log('Request Content-Type:', req.headers['content-type']);
    console.log('Request body:', JSON.stringify(req.body, null, 2)); // Assuming JSON body primarily

    let campaignId;
    let numberOfUnits;
    let endorsementNote;
    let requestAdAccountId;

    // Prefer JSON body parsing
    if (req.is('json') || (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0)) {
        campaignId = req.body.campaignId;
        numberOfUnits = req.body.numberOfUnits;
        endorsementNote = req.body.endorsementNote;
        requestAdAccountId = req.body.adAccountId;
         console.log("Extracted from JSON body:", { campaignId, numberOfUnits, endorsementNote, requestAdAccountId });
    } else {
        // Fallback for urlencoded or potentially query params if needed
         campaignId = req.body.campaignId || req.query.campaignId;
         numberOfUnits = req.body.numberOfUnits || req.query.numberOfUnits;
         endorsementNote = req.body.endorsementNote || req.query.endorsementNote;
         requestAdAccountId = req.body.adAccountId || req.query.adAccountId;
         console.log("Extracted from form-data/query:", { campaignId, numberOfUnits, endorsementNote, requestAdAccountId });
    }

    numberOfUnits = parseInt(numberOfUnits, 10) || 1; // Ensure it's a number, default to 1

    // Get access token injected by middleware or passed in body/query
    const accessToken = req.accessToken || req.body.accessToken || req.query.accessToken;

    // Determine effective Ad Account ID (request > environment variable)
    // Ensure adAccountId is just the number string here, 'act_' is added later if needed
    const effectiveAdAccountId = (requestAdAccountId || adAccountId)?.replace('act_', '');

    console.log("Access token present:", !!accessToken);
    console.log("Effective Ad Account ID (numeric):", effectiveAdAccountId);
    console.log("Effective Page ID:", pageId);

    // --- Input Validation ---
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required.' });
    if (!pageId) return res.status(400).json({ error: 'Facebook Page ID is missing in server configuration.' });
    if (!effectiveAdAccountId) return res.status(400).json({ error: 'Facebook Ad Account ID is required (provide in request or set env var).' });
    if (!accessToken) return res.status(400).json({ error: 'Facebook access token is required.' });
    if (!req.app?.locals?.db) {
        console.error("Database connection not available!");
        return res.status(500).json({ error: 'Database connection not available.' });
    }
     if (isNaN(numberOfUnits) || numberOfUnits <= 0) {
        return res.status(400).json({ error: 'Invalid numberOfUnits provided.' });
     }


    const pool = req.app.locals.db;
    let fileToDelete = null; // Track temporary file for cleanup

    try {
        // --- 1. Fetch Campaign Details from DB ---
        const query = `
            SELECT /* Fields */
                c.Id AS CampaignId, c.CampaignTitle, c.Description AS CampaignDescription,
                c.CampaignLink, cat.CategoryName AS CampaignCategory,
                cf.FilePath AS CampaignFilePath, cf.FileType AS CampaignFileType
            FROM Campaigns AS c
            INNER JOIN Categories AS cat ON c.CategoryId = cat.Id
            LEFT JOIN CampaignFiles AS cf ON c.Id = cf.CampaignId
            WHERE c.Id = @campaignId;
        `; // Select only necessary fields
        console.log("Executing database query for campaignId:", campaignId);
        const result = await pool.request()
            .input('campaignId', sql.Int, parseInt(campaignId, 10))
            .query(query);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Campaign not found.', campaignIdUsed: campaignId });
        }
        const campaign = result.recordset[0];
        console.log(`Campaign found: ID=${campaign.CampaignId}, Title=${campaign.CampaignTitle}`);
        console.log(`Campaign file path: ${campaign.CampaignFilePath}, Type: ${campaign.CampaignFileType}`);

        if (!campaign.CampaignFilePath) {
            return res.status(400).json({ error: 'No campaign file available for posting.' });
        }
        const isImage = campaign.CampaignFileType?.toLowerCase().includes('image') || campaign.CampaignFileType?.toLowerCase().match(/\.(jpg|jpeg|png|gif|bmp|webp)$/i);
        const isVideo = campaign.CampaignFileType?.toLowerCase().includes('video') || campaign.CampaignFileType?.toLowerCase().match(/\.(mp4|mov|avi|wmv|flv|mkv)$/i);

        if (!isImage && !isVideo) {
            return res.status(400).json({ error: 'Campaign file is not a supported image or video type.', fileType: campaign.CampaignFileType });
        }

        // --- 2. Prepare File ---
        const localFilePath = await downloadFileIfNeeded(campaign.CampaignFilePath);
        fileToDelete = localFilePath.startsWith(os.tmpdir()) ? localFilePath : null; // Mark for deletion only if temporary

        if (!fs.existsSync(localFilePath)) {
            return res.status(404).json({ error: 'Campaign file not found or inaccessible after download attempt.', path: localFilePath });
        }

        // --- 3. Construct Post Message ---
        const endorsementText = endorsementNote ? `Endorsement: ${endorsementNote}\n\n` : '';
        const message = `${campaign.CampaignTitle || 'Check this out!'}\n\n` +
                        `${campaign.CampaignDescription || ''}\n\n` +
                        `${endorsementText}` +
                        `Link: ${campaign.CampaignLink || 'https://www.iendorse.ng/'}\n\n` +
                        `#${(campaign.CampaignCategory || 'General').replace(/\s+/g, '')}`; // Example hashtag


        // --- 4. Post to Facebook Page ---
        const postFormData = new FormData();
        postFormData.append('access_token', accessToken);
        postFormData.append('message', message);
        // For videos, title and description might be separate fields if API requires
        if (isVideo) {
             postFormData.append('description', message); // Video endpoint often uses 'description'
             // postFormData.append('title', campaign.CampaignTitle); // Optional video title
        }
        postFormData.append(isVideo ? 'source' : 'source', fs.createReadStream(localFilePath)); // Use 'source' for both vids/photos now

        const postUrl = `${BASE_URL}/${pageId}/${isVideo ? 'videos' : 'photos'}`;
        console.log(`Posting to Facebook Page URL: ${postUrl}`);

        const postResponse = await axios.post(postUrl, postFormData, {
            headers: { ...postFormData.getHeaders() },
            maxContentLength: Infinity, // Allow large file uploads
            maxBodyLength: Infinity
        });

        if (postResponse.status !== 200) { // Check status code strictly
            console.error('Facebook Page Post API error:', postResponse.data);
            // Attempt cleanup before returning error
             if (fileToDelete) fs.unlink(fileToDelete, (err) => { if(err) console.error("Error deleting temp file on post failure:", err);});
            return res.status(500).json({ error: 'Failed to post to Facebook Page.', details: postResponse.data });
        }

        // const mediaId = postResponse.data.id; // Photo posts return 'id'
        const postId = postResponse.data.post_id || postResponse.data.id; // Video posts often return 'post_id', photos 'id'
         if (!postId) {
            console.error('Facebook Page Post API did not return a usable ID:', postResponse.data);
             if (fileToDelete) fs.unlink(fileToDelete, (err) => { if(err) console.error("Error deleting temp file on post failure (no ID):", err);});
             return res.status(500).json({ error: 'Failed to get Post ID from Facebook after posting.', details: postResponse.data });
         }
        console.log(`Successfully posted to Facebook Page. Post ID: ${postId}`);


        // --- 5. Save Record to DynamoDB ---
        const timestamp = Date.now();
        const dbRecordId = uuidv4(); // Unique ID for the DB record itself
        const postRecordData = {
            recordId: dbRecordId, // Primary key for DynamoDB?
            pageId: pageId,
            timestamp: timestamp,
            postId: postId, // Store the actual Facebook Post ID
            campaignId: campaign.CampaignId.toString(), // Ensure string for DB if needed
            type: isVideo ? 'video' : 'image',
            message: message, // Store the generated message
            // Add other relevant fields maybe?
             budgetUnits: numberOfUnits,
             adAccountIdUsed: effectiveAdAccountId,
        };
        await savePostRecord(postRecordData); // Log to DynamoDB

        // --- 6. Create Facebook Ad (using the new function) ---
        let adResult = null;
        const budgetAmount = numberOfUnits * 100; // Example: 1 unit = 100 NGN? Adjust multiplier as needed!
        const adDurationDays = 1; // Or make this dynamic

        try {
            adResult = await createFacebookAdForPost({
                postId: postId,
                pageId: pageId,
                budget: budgetAmount,
                durationDays: adDurationDays,
                accessToken: accessToken,
                adAccountId: effectiveAdAccountId, // Pass the numeric ID
                campaignName: `Ad for ${campaign.CampaignTitle}`, // Dynamic name
                targeting: { // Pass the simple targeting for now
                    geo_locations: { countries: ['NG'] },
                    age_min: 18,
                    age_max: 65
                }
            });
             // Optionally update DynamoDB record with ad IDs
             // await updatePostRecordWithAdIds(dbRecordId, adResult);

        } catch (adError) {
            console.error('Error creating Facebook Ad after successful post:', adError);
            // Post was successful, but ad creation failed. Return success for post, but include ad error.
            adResult = { error: adError.message };
        }

        // --- 7. Cleanup and Respond ---
        if (fileToDelete) {
            console.log(`Cleaning up temporary file: ${fileToDelete}`);
            fs.unlink(fileToDelete, (err) => {
                if (err) console.error("Error deleting temporary file:", err);
                else console.log("Temporary file deleted successfully.");
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Content posted to Facebook Page successfully.',
            postId: postId, // Return the actual Facebook Post ID
             adCreation: adResult // Include the detailed ad creation result (or error)
            // campaignDetails: campaign // Optionally include campaign details if needed by client
        });

    } catch (error) {
        console.error('---------------- ERROR PROCESSING REQUEST ----------------');
        console.error('Error Type:', error.constructor.name);
        console.error('Error Message:', error.message);
         if (error.response) { // Axios error details
             console.error('Axios Error Status:', error.response.status);
             console.error('Axios Error Data:', JSON.stringify(error.response.data, null, 2));
         } else {
             console.error('Error Stack:', error.stack); // Log stack for non-Axios errors
         }
        console.error('---------------- END ERROR DETAILS ----------------');

        // Attempt cleanup even on error
        if (fileToDelete && fs.existsSync(fileToDelete)) {
             console.log(`Cleaning up temporary file due to error: ${fileToDelete}`);
             fs.unlink(fileToDelete, (err) => { if (err) console.error("Error deleting temporary file on main error:", err); });
         }

        // Determine appropriate status code
        let statusCode = 500;
        if (error.message.includes('Campaign not found') || error.message.includes('file not found')) {
            statusCode = 404;
        } else if (error.message.includes('required') || error.message.includes('Invalid')) {
            statusCode = 400;
        } else if (error.response?.status) {
            statusCode = error.response.status >= 500 ? 502 : error.response.status; // Proxy FB errors or use their status
        }

        return res.status(statusCode).json({
            success: false,
            error: 'Failed to process request.',
            details: error.message, // Provide error message
             facebookError: error.response?.data?.error // Include FB error object if available
        });
    }
});

module.exports = router;