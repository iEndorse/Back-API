// routes/iendorse.js

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sql = require('mssql');

const router = express.Router();
const multer = require('multer');
// Add body parser middleware to this specific router
// This ensures that req.body is properly parsed regardless of the app-level configuration
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Load environment variables
const pageId = process.env.PAGE_ID;

// DynamoDB setup
const AWS = require('aws-sdk');
AWS.config.update({
    region: 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = 'FacebookPosts';

async function createPost(postData) {
    const params = {
        TableName: TABLE_NAME,
        Item: postData,
    };

    try {
        await dynamoDB.put(params).promise();
        console.log('Post created successfully.');
    } catch (error) {
        console.error('Error creating post:', error);
        throw error;
    }
}

// Function to download file if it's at a remote URL
async function downloadFileIfNeeded(filePath) {
    if (!filePath) {
        throw new Error('File path is undefined or null');
    }

    // Check if the path is a URL (starts with http:// or https://)
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        try {
            const response = await axios({
                method: 'get',
                url: filePath,
                responseType: 'stream'
            });

            // Create a temporary file path
            const tempFilePath = path.join('temp', path.basename(filePath));

            // Ensure temp directory exists
            if (!fs.existsSync('temp')) {
                fs.mkdirSync('temp');
            }

            // Create a write stream to save the file
            const writer = fs.createWriteStream(tempFilePath);

            // Pipe the response data to the file
            response.data.pipe(writer);

            // Return a promise that resolves when the file is downloaded
            return new Promise((resolve, reject) => {
                writer.on('finish', () => resolve(tempFilePath));
                writer.on('error', reject);
            });
        } catch (error) {
            console.error('Error downloading file:', error);
            throw error;
        }
    } else {
        // If it's a local path, just return it
        return filePath;
    }
}

// Endpoint to handle endorsement and post to Facebook page
// Set up multer for handling form-data
const upload = multer(); // No storage configuration for non-file fields

//router.post('/endorse-photo', upload.none(), async (req, res) => {
// Log the request body
// router.post('/endorse-photo', async (req, res) => { 


router.post('/endorse-campaign', upload.none(), async (req, res) => {
    console.log('================= NEW REQUEST =================');
    console.log('Request body type:', typeof req.body);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Request headers:', req.headers);
    console.log('Request params:', req.params);
    console.log('Request query:', req.query);

    // Try to extract campaignId from all possible sources
    let campaignId;

    // Check if we have a JSON body
    if (req.body && typeof req.body === 'object') {
        campaignId = req.body.campaignId;
    }

    // If not found in body, check query parameters
    if (!campaignId && req.query) {
        campaignId = req.query.campaignId;
    }

    // If STILL not found, check if the body might be a string that needs parsing
    if (!campaignId && req.body && typeof req.body === 'string') {
        try {
            const parsedBody = JSON.parse(req.body);
            campaignId = parsedBody.campaignId;
        } catch (e) {
            // If parsing fails, log but continue
            console.log('Could not parse body as JSON:', e.message);
        }
    }

    // Get access token from request
    const accessToken = req.accessToken || req.body.accessToken || req.query.accessToken;
    console.log("Access token present:", !!accessToken);

    try {
        // Extract other data
        const numberOfUnits = req.body.numberOfUnits || req.query.numberOfUnits;
        const endorsementNote = req.body.endorsementNote || req.query.endorsementNote;

        console.log("Extracted campaignId:", campaignId);


        // Validate required fields
        if (!campaignId) {
            return res.status(400).json({
                error: 'Campaign ID is required.',
                receivedBody: req.body,
                receivedQuery: req.query,
                contentType: req.headers['content-type']
            });
        }

        if (!pageId) {
            return res.status(400).json({ error: 'Facebook Page ID is required.' });
        }

        console.log("Using campaignId:", campaignId);
        console.log("Using numberOfUnits:", numberOfUnits);

        // Get the database connection pool
        if (!req.app || !req.app.locals || !req.app.locals.db) {
            console.error("Database connection not available!");
            return res.status(500).json({ error: 'Database connection not available.' });
        }

        const pool = req.app.locals.db;

        // Query to retrieve campaign information
        const query = `
            SELECT
                c.Id AS CampaignId,
                c.CampaignTitle,
                c.Description AS CampaignDescription,
                c.CampaignUnit,
                c.CampaignUnitUsed,
                c.CampaignLink,
                cat.CategoryName AS CampaignCategory,
                a.FullName AS CampaignOwnerName,
                a.EmailAddress AS CampaignOwnerEmail,
                cf.FilePath AS CampaignFilePath,
                cf.FileType AS CampaignFileType,
                cf.MetaData AS CampaignFileMetaData
            FROM
                Campaigns AS c
            INNER JOIN
                Categories AS cat ON c.CategoryId = cat.Id
            INNER JOIN
                Accounts AS a ON c.AccountId = a.Id
            LEFT JOIN
                CampaignFiles AS cf ON c.Id = cf.CampaignId
            WHERE
                c.Id = @campaignId;
        `;

        console.log("Executing database query with campaignId:", campaignId);

        // Execute the query with parameterized input
        const result = await pool.request()
            .input('campaignId', sql.Int, parseInt(campaignId, 10))
            .query(query);

        console.log("Query result count:", result.recordset.length);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                error: 'Campaign not found.',
                campaignIdUsed: campaignId
            });
        }

        const campaign = result.recordset[0];
        console.log("Campaign found:", campaign.CampaignId);

        // Create post content using campaign data
        //const photoTitle = campaign.CampaignId.toString() || '';
        const photoDescription = campaign.CampaignDescription || '';
        const campaignTitle = campaign.CampaignTitle || '';
        const campaignLink = campaign.CampaignLink || 'https://www.iendorse.ng/';
        const campaignTargetAudienceAnswer = campaign.CampaignCategory ? `#${campaign.CampaignCategory}` : '';
        const campaignFilePath = campaign.CampaignFilePath;
        const campaignFileType = campaign.CampaignFileType;

        console.log("Campaign file path:", campaignFilePath);
        console.log("Campaign file type:", campaignFileType);

        // Check if we have a valid file to post
        if (!campaignFilePath) {
            return res.status(400).json({ error: 'No campaign file available for posting.' });
        }

        // Verify file type is appropriate for posting
        const isImage = campaignFileType &&
            (campaignFileType.toLowerCase().includes('image') ||
                campaignFileType.toLowerCase().includes('jpg') ||
                campaignFileType.toLowerCase().includes('jpeg') ||
                campaignFileType.toLowerCase().includes('png'));

        const isVideo = campaignFileType &&
            (campaignFileType.toLowerCase().includes('video') ||
                campaignFileType.toLowerCase().includes('mp4') ||
                campaignFileType.toLowerCase().includes('mov'));

        if (!isImage && !isVideo) {
            return res.status(400).json({
                error: 'Campaign file is not an image or video.',
                fileType: campaignFileType
            });
        }

        try {
            // Download the file if it's a URL, or use local path
            console.log("Attempting to download or locate file:", campaignFilePath);
            const fileToUpload = await downloadFileIfNeeded(campaignFilePath);
            console.log("File to upload:", fileToUpload);

            // Check if the file exists
            if (!fs.existsSync(fileToUpload)) {
                return res.status(404).json({
                    error: 'Campaign file not found on server.',
                    path: fileToUpload
                });
            }

            // Add endorsement note if provided
            const endorsementText = endorsementNote ? `Endorsement: ${endorsementNote}\n` : '';

            // Create unique identifiers for the post
            const postId = uuidv4();
            const timestamp = Date.now();

            // Construct the message for Facebook
            const message = `
${endorsementText}
${campaignTitle}
${photoDescription}   
${campaignLink}
${campaignTargetAudienceAnswer}
            `;

            // Check if we have a valid access token
            if (!accessToken) {
                return res.status(400).json({ error: 'Facebook access token is required.' });
            }

            // Prepare form data for Facebook API
            const formData = new FormData();
            formData.append('access_token', accessToken);
            formData.append('file', fs.createReadStream(fileToUpload));
            // formData.append('message', message);
            if (isVideo) {
                formData.append('description', message); // Not 'message' for video
            } else {
                formData.append('message', message); // 'message' works for photos
            }

            // Determine the appropriate Facebook endpoint based on file type
            let url;
            if (isVideo) {
                url = `https://graph.facebook.com/v19.0/${pageId}/videos`;
            } else {
                url = `https://graph.facebook.com/v19.0/${pageId}/photos`;
            }

            console.log("Posting to Facebook URL:", url);

            // Send request to Facebook API
            const response = await axios.post(url, formData, {
                headers: { ...formData.getHeaders() },
            });

            console.log("Facebook API response status:", response.status);

            if (response.status !== 200) {
                console.error('Facebook API error:', response.data);
                return res.status(500).json({ error: 'Facebook API error' });
            }

            // Get media ID from Facebook response
            const mediaId = response.data.id;
            console.log("Facebook media ID:", mediaId);

            // Store post information in DynamoDB
            const postData = {
                pageId: pageId,
                timestamp: timestamp,
                postId: postId,
                mediaId: mediaId,
                type: isVideo ? 'video' : 'image',

                photoDescription: photoDescription,
                campaignTitle: campaignTitle,
                campaignLink: campaignLink,
                campaignTargetAudienceAnswer: campaignTargetAudienceAnswer,
                endorsementNote: endorsementNote || '',
                numberOfUnits: numberOfUnits || 0,
                campaignFilePath: campaignFilePath || null,
                message: message
            };






            await createPost(postData);

            // Clean up if we created a temporary file
            if (fileToUpload.startsWith('temp/') && fs.existsSync(fileToUpload)) {
                fs.unlinkSync(fileToUpload);
            }

            return res.status(200).json({
                success: true,
                id: mediaId,
                message: 'Endorsement posted successfully to Facebook.',
                campaign: campaign
            });

        } catch (fileError) {
            console.error('Error with file processing:', fileError);
            return res.status(500).json({
                error: 'Failed to process file.',
                details: fileError.message
            });
        }

    } catch (error) {
        console.error('Error processing endorsement:', error.message);
        console.error('Error stack:', error.stack);
        return res.status(500).json({
            error: 'Failed to process endorsement.',
            details: error.message,
            stack: error.stack
        });
    }
});

module.exports = router;