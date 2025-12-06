// This route handles the conversion of images to videos and posting them to Facebook.
// It uses FFmpeg to create videos from images and stores post information in DynamoDB.
// It also handles file downloads, error handling, and cleanup of temporary files.
// It is designed to be used with an Express.js application and requires AWS SDK, Axios, and FFmpeg libraries.
// It is a part of a larger application that manages social media campaigns and endorsements.

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sql = require('mssql');
const router = express.Router();
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg'); // Import fluent-ffmpeg

// Add body parser middleware to this specific router
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Load environment variables
const pageId = process.env.PAGE_ID;
const TEMP_DIR = 'temp'; // Define temp directory

// DynamoDB setup (Keep as is)
const AWS = require('aws-sdk');

if (!process.env.AWS_EXECUTION_ENV) {
    // Local dev ONLY
    AWS.config.update({
        region: 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
} else {
    // Lambda – rely on role/region
    AWS.config.update({
        region: process.env.AWS_REGION || 'us-east-1',
    });
}
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = 'FacebookPosts';

async function createPost(postData) {
    const params = {
        TableName: TABLE_NAME,
        Item: postData,
    };
    try {
        await dynamoDB.put(params).promise();
        console.log('Post created successfully in DynamoDB.');
    } catch (error) {
        console.error('Error creating post in DynamoDB:', error);
        throw error; // Re-throw to be caught by the main handler
    }
}

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
    console.log(`Created temporary directory: ${TEMP_DIR}`);
}

// Function to download file if it's at a remote URL
async function downloadFileIfNeeded(filePath, targetDir = TEMP_DIR) {
    if (!filePath) {
        throw new Error('File path is undefined or null');
    }

    const filename = path.basename(filePath);
    // Sanitize filename to avoid issues, keep extension
    const safeFilename = `${uuidv4()}_${filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const tempFilePath = path.join(targetDir, safeFilename);

    // Check if the path is a URL
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        try {
            console.log(`Downloading remote file: ${filePath} to ${tempFilePath}`);
            const response = await axios({
                method: 'get',
                url: filePath,
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    console.log(`Successfully downloaded ${filePath}`);
                    resolve(tempFilePath);
                });
                writer.on('error', (err) => {
                     console.error(`Error downloading file ${filePath}:`, err);
                     // Attempt to clean up partially downloaded file
                     if (fs.existsSync(tempFilePath)) {
                         fs.unlink(tempFilePath, unlinkErr => {
                             if (unlinkErr) console.error(`Error deleting partially downloaded file ${tempFilePath}:`, unlinkErr);
                         });
                     }
                     reject(err);
                });
                response.data.on('error', (err) => { // Also catch errors on the read stream
                    console.error(`Error reading response stream for ${filePath}:`, err);
                    writer.close(); // Close writer stream
                    reject(err);
                });
            });
        } catch (error) {
            console.error(`Error initiating download for ${filePath}:`, error.message);
            // Check if the error is from Axios (e.g., 404 Not Found)
             if (error.response) {
                 console.error(`Download failed with status: ${error.response.status}`);
             }
            throw error;
        }
    } else {
         // If it's a local path, check existence and return it (or copy to temp? For consistency, let's copy)
        if (!fs.existsSync(filePath)) {
             throw new Error(`Local file not found: ${filePath}`);
        }
        console.log(`Using local file: ${filePath}. Copying to ${tempFilePath}`);
        // Copying to temp ensures all files are handled similarly and cleaned up
        // Use stream copy for potentially large files
        return new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(filePath);
            const writeStream = fs.createWriteStream(tempFilePath);
            readStream.on('error', reject);
            writeStream.on('error', reject);
            writeStream.on('finish', () => resolve(tempFilePath));
            readStream.pipe(writeStream);
        });

    }
}

// --- NEW FUNCTION: Combine images into video using FFmpeg ---
// --- Refined function to Combine images into video using FFmpeg ---
async function createVideoFromImages(imagePaths, outputVideoPath, duration = 50) {
    return new Promise((resolve, reject) => {
        if (!imagePaths || imagePaths.length === 0) {
            return reject(new Error("No image paths provided for video creation."));
        }

        const totalImages = imagePaths.length;
        // Calculate duration, ensuring it's not zero
        const durationPerImage = Math.max(0.1, duration / totalImages);
        const outputFps = 25; // Standard video frame rate

        console.log(`Creating video from ${totalImages} images. Aiming for duration per image: ${durationPerImage.toFixed(2)}s. Total duration: ${duration}s.`);

        const command = ffmpeg();
        const listFilePath = path.join(TEMP_DIR, `ffmpeg_list_${uuidv4()}.txt`);
        let fileContent = '';

        // --- CHANGE: Modify how the list file is created ---
        imagePaths.forEach((relativePath, index) => {
            const absoluteImgPath = path.resolve(relativePath);
            const ffmpegPath = absoluteImgPath.replace(/\\/g, '/'); // Ensure forward slashes

            fileContent += `file '${ffmpegPath}'\n`;

            // Add duration line *only if it's NOT the last image*
            if (index < imagePaths.length - 1) {
                 // We calculate the *in point* for the *next* segment, which effectively defines the current segment's duration
                 // Let's stick to the simpler 'duration' for now, as 'inpoint' is more complex.
                 // Testing shows 'duration' should work better if applied correctly.
                 fileContent += `duration ${durationPerImage}\n`;
            }
            // For the last file, we don't add a duration line. Its duration will be
            // determined by the time remaining until the total output duration (-t 50) is reached.
        });
        // --- END CHANGE ---

        // Remove the previous logic that added the last image again.

        fs.writeFileSync(listFilePath, fileContent);
        console.log(`FFmpeg concat list file created at: ${listFilePath}`);
        // Optional: Log content for debugging
        console.log('List file content:\n', fileContent);

        command
            .input(listFilePath)
            .inputOptions([
                '-f concat',
                '-safe 0',
                // Maybe force input frame rate interpretation? Might conflict with duration. Let's omit for now.
                // '-r 1' // Treat each image as 1 frame per second initially?
                ])
            .outputOptions([
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2', // Keep scale filter for even dimensions
                // '-vsync vfr', // VFR might be less predictable with concat durations? Try CFR.
                '-vsync cfr', // Use Constant Frame Rate sync. Might help timing.
                `-t ${duration}`, // Keep the total duration target
                '-pix_fmt yuv420p',
                `-r ${outputFps}` // Set output frame rate
            ])
            .output(outputVideoPath)
            .on('start', (commandLine) => {
                console.log('FFmpeg process started:', commandLine);
            })
            .on('end', () => {
                console.log(`Video successfully created: ${outputVideoPath}`);
                fs.unlink(listFilePath, err => {
                    if(err) console.error(`Error deleting ffmpeg list file ${listFilePath}:`, err);
                });
                resolve(outputVideoPath);
            })
            .on('error', (err, stdout, stderr) => {
                console.error('Error during FFmpeg processing:', err.message);
                console.error('FFmpeg stdout:', stdout);
                console.error('FFmpeg stderr:', stderr);
                fs.unlink(listFilePath, unlinkErr => {
                    if(unlinkErr) console.error(`Error deleting ffmpeg list file ${listFilePath} after error:`, unlinkErr);
                });
                reject(new Error(`FFmpeg error: ${err.message}\nStderr: ${stderr}`));
            })
            .run();
    });
}
// --- Helper function to safely delete files ---
function safeUnlink(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up temporary file: ${filePath}`);
        } catch (unlinkErr) {
            console.error(`Error deleting temporary file ${filePath}:`, unlinkErr);
        }
    }
}


// Endpoint to handle endorsement and post to Facebook page
const upload = multer(); // No storage configuration needed

router.post('/social-campaign', upload.none(), async (req, res) => {
    console.log('================= NEW REQUEST (endorse-campaign) =================');
    console.log('Node.js process PATH:', process.env.PATH);
    console.log('Request body:', JSON.stringify(req.body, null, 2)); // Log parsed body if available

    let campaignId;
    if (req.body && typeof req.body === 'object') campaignId = req.body.campaignId;
    if (!campaignId && req.query) campaignId = req.query.campaignId;

    const accessToken = req.accessToken || req.body.accessToken || req.query.accessToken;
    const numberOfUnits = req.body.numberOfUnits || req.query.numberOfUnits;
    const endorsementNote = req.body.endorsementNote || req.query.endorsementNote;

    console.log("Access token present:", !!accessToken);
    console.log("Extracted campaignId:", campaignId);

    if (!campaignId) {
        return res.status(400).json({ error: 'Campaign ID is required.' });
    }
    if (!pageId) {
        return res.status(400).json({ error: 'Facebook Page ID is required.' });
    }
     if (!accessToken) {
        return res.status(400).json({ error: 'Facebook access token is required.' });
    }

    // Keep track of temporary files to clean up
    const tempFilesToDelete = [];
    let finalMediaToUploadPath = null; // Path to the single video/image or the combined video
    let isVideoPost = false; // Flag to determine FB endpoint

    try {
        if (!req.app || !req.app.locals || !req.app.locals.db) {
            console.error("Database connection not available!");
            return res.status(500).json({ error: 'Database connection not available.' });
        }
        const pool = req.app.locals.db;

        // --- Step 1: Get Campaign Base Info ---
        const campaignInfoQuery = `
            SELECT
                c.Id AS CampaignId, c.CampaignTitle, c.Description AS CampaignDescription,
                c.CampaignUnit, c.CampaignUnitUsed, c.CampaignLink,
                cat.CategoryName AS CampaignCategory, a.FullName AS CampaignOwnerName,
                a.EmailAddress AS CampaignOwnerEmail
            FROM Campaigns AS c
            INNER JOIN Categories AS cat ON c.CategoryId = cat.Id
            INNER JOIN Accounts AS a ON c.AccountId = a.Id
            WHERE c.Id = @campaignId;
        `;
        const campaignInfoResult = await pool.request()
            .input('campaignId', sql.Int, parseInt(campaignId, 10))
            .query(campaignInfoQuery);

        if (campaignInfoResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Campaign not found.' });
        }
        const campaign = campaignInfoResult.recordset[0];
        console.log("Campaign base info found:", campaign.CampaignId);


        // --- Step 2: Get ALL Campaign Files ---
        const campaignFilesQuery = `
            SELECT FilePath, FileType
            FROM CampaignFiles
            WHERE CampaignId = @campaignId;
        `;
        const filesResult = await pool.request()
            .input('campaignId', sql.Int, parseInt(campaignId, 10))
            .query(campaignFilesQuery);

        if (filesResult.recordset.length === 0) {
            return res.status(400).json({ error: 'No campaign files found for this campaign ID.' });
        }

        const campaignFiles = filesResult.recordset;
        console.log(`Found ${campaignFiles.length} file(s) for campaign ${campaignId}.`);

        // --- Step 3: Process Files (Download & Combine if needed) ---
        const downloadedFilePaths = [];
        const fileTypes = [];

        // Download all files first
        try {
             const downloadPromises = campaignFiles.map(file =>
                 downloadFileIfNeeded(file.FilePath)
                    .then(tempPath => {
                        tempFilesToDelete.push(tempPath); // Mark for cleanup
                        downloadedFilePaths.push(tempPath);
                        fileTypes.push(file.FileType?.toLowerCase() || ''); // Store lowercase type
                        return tempPath; // Return path for Promise.all result (optional)
                    })
             );
             await Promise.all(downloadPromises);
             console.log(`Successfully downloaded ${downloadedFilePaths.length} files.`);
        } catch (downloadError) {
             console.error('Error during file download phase:', downloadError);
             throw new Error(`Failed to download one or more campaign files: ${downloadError.message}`); // Throw to trigger cleanup
        }


        // Check file types and decide action
        const allImages = downloadedFilePaths.length > 0 && fileTypes.every(type => type.includes('image') || type.includes('jpg') || type.includes('jpeg') || type.includes('png'));
        const singleVideo = downloadedFilePaths.length === 1 && (fileTypes[0].includes('video') || fileTypes[0].includes('mp4') || fileTypes[0].includes('mov'));
        const singleImage = downloadedFilePaths.length === 1 && !singleVideo && allImages; // Check it's an image if only one file


        if (downloadedFilePaths.length > 1 && allImages) {
            // --- Combine multiple images into video ---
            console.log("Multiple images found. Attempting to combine into a video.");
            const outputVideoFilename = `campaign_${campaignId}_${uuidv4()}.mp4`;
            const outputVideoPath = path.join(TEMP_DIR, outputVideoFilename);
            tempFilesToDelete.push(outputVideoPath); // Mark generated video for cleanup

            try {
                finalMediaToUploadPath = await createVideoFromImages(downloadedFilePaths, outputVideoPath, 50); // 50 seconds duration
                isVideoPost = true;
                console.log(`Video generated successfully at ${finalMediaToUploadPath}`);
            } catch (ffmpegError) {
                console.error("FFmpeg video creation failed:", ffmpegError);
                throw new Error(`Failed to create video from images: ${ffmpegError.message}`);
            }

        } else if (singleVideo) {
            // --- Use the single downloaded video ---
            console.log("Single video file found.");
            finalMediaToUploadPath = downloadedFilePaths[0];
            isVideoPost = true;

        } else if (singleImage) {
            // --- Use the single downloaded image ---
             console.log("Single image file found.");
             finalMediaToUploadPath = downloadedFilePaths[0];
             isVideoPost = false; // Post as photo

        } else if (downloadedFilePaths.length > 0) {
             // --- Handle mixed types or multiple videos (fallback) ---
             console.warn("Multiple files found, but not all are images or it's multiple videos. Using the first file.");
             // Fallback: use the first file found. Determine if it's video or image.
             finalMediaToUploadPath = downloadedFilePaths[0];
             const firstFileType = fileTypes[0];
             isVideoPost = firstFileType.includes('video') || firstFileType.includes('mp4') || firstFileType.includes('mov');
        } else {
            // This case should technically be caught earlier, but as a safeguard:
            throw new Error("No valid media files could be processed for the campaign.");
        }

        // Verify the final media file exists
        if (!finalMediaToUploadPath || !fs.existsSync(finalMediaToUploadPath)) {
             throw new Error(`The final media file to upload does not exist at path: ${finalMediaToUploadPath}`);
        }
        console.log(`Preparing to upload: ${finalMediaToUploadPath}. Is video post: ${isVideoPost}`);


        // --- Step 4: Post to Facebook ---
        const endorsementText = endorsementNote ? `Endorsement: ${endorsementNote}\n\n` : '';
        const message = `${campaign.CampaignTitle || 'Campaign'}\n${campaign.CampaignDescription || ''}\n\n${endorsementText}Link: ${campaign.CampaignLink || 'https://www.iendorse.ng/'}\nCategory: ${campaign.CampaignCategory || 'General'}`;


        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('message', message);
        // Use 'source' for videos, 'source' or 'file' for photos (let's use 'source' for consistency)
        formData.append('source', fs.createReadStream(finalMediaToUploadPath));


        // Determine the appropriate Facebook endpoint
        const facebookUrl = `https://graph-video.facebook.com/v19.0/${pageId}/${isVideoPost ? 'videos' : 'photos'}`;
        console.log(`Posting to Facebook URL: ${facebookUrl}`);

        const response = await axios.post(facebookUrl, formData, {
            headers: { ...formData.getHeaders() },
            maxContentLength: Infinity, // Allow large file uploads
            maxBodyLength: Infinity
        });

        console.log("Facebook API response status:", response.status);
        console.log("Facebook API response data:", response.data);

        if (response.status !== 200 || !response.data.id) {
            console.error('Facebook API error:', response.data);
            // Attempt to parse potential FB error structure
             let fbErrorMsg = 'Facebook API error';
             if (response.data && response.data.error && response.data.error.message) {
                 fbErrorMsg = `Facebook API Error: ${response.data.error.message}`;
             } else if (typeof response.data === 'string') {
                 fbErrorMsg = `Facebook API Error: ${response.data}`;
             }
            throw new Error(fbErrorMsg);
        }

        const mediaId = response.data.id;
        console.log("Facebook media ID:", mediaId);

        // --- Step 5: Store post information in DynamoDB ---
        const postId = uuidv4();
        const timestamp = new Date().toISOString(); // Use ISO string for DynamoDB sort key

        const postData = {
            pageId: pageId,
            timestamp: timestamp, // Sort Key
            postId: postId,       // Primary Key (or part of it if timestamp is sort)
            mediaId: mediaId,
            type: isVideoPost ? 'video' : 'image',
            campaignId: campaign.CampaignId,
            campaignTitle: campaign.CampaignTitle || '',
            campaignDescription: campaign.CampaignDescription || '',
            campaignLink: campaign.CampaignLink || '',
            campaignCategory: campaign.CampaignCategory || '',
            endorsementNote: endorsementNote || '',
            numberOfUnits: numberOfUnits || 0,
            // Store paths of *original* files, not temporary ones
            originalFilePaths: campaignFiles.map(f => f.FilePath),
            message: message,
            status: 'posted' // Indicate success
        };

        await createPost(postData);

        // --- Success Response ---
        return res.status(200).json({
            success: true,
            id: mediaId,
            message: `Campaign ${isVideoPost ? 'video' : 'photo'} posted successfully to Facebook.`,
            campaignId: campaign.CampaignId,
            postType: isVideoPost ? 'video' : 'image'
        });

    } catch (error) {
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        console.error('Error processing endorsement:', error.message);
        console.error('Error stack:', error.stack);
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');

        // Add a status to DynamoDB if possible (e.g., if campaign info was fetched)
        if (campaignId && pageId) {
             try {
                  const errorPostData = {
                      pageId: pageId,
                      timestamp: new Date().toISOString(),
                      postId: uuidv4(),
                      campaignId: parseInt(campaignId, 10), // Ensure it's a number if possible
                      status: 'failed',
                      errorMessage: error.message,
                      errorStack: error.stack?.substring(0, 1000) // Limit stack trace length
                  };
                  await createPost(errorPostData); // Log failure attempt
                  console.log("Failure logged to DynamoDB.");
             } catch (dbError) {
                 console.error("Failed to log failure to DynamoDB:", dbError);
             }
        }


        return res.status(500).json({
            error: 'Failed to process endorsement.',
            details: error.message,
            // stack: process.env.NODE_ENV === 'development' ? error.stack : undefined // Only show stack in dev
        });

    } finally {
        // --- Step 6: Cleanup Temporary Files ---
        console.log(`Cleaning up ${tempFilesToDelete.length} temporary file(s)...`);
        tempFilesToDelete.forEach(filePath => {
            safeUnlink(filePath);
        });
        console.log("Cleanup complete.");
    }
});

module.exports = router;