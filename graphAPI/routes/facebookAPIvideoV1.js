const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Multer setup for video upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Add video file type validation
        const allowedTypes = ['video/mp4', 'video/mpeg', 'video/quicktime'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid video file type. Only MP4, MPEG, and QuickTime videos are allowed.'));
        }
    },
    limits: {
        fileSize: 1024 * 1024 * 1024 // 1GB file size limit
    }
});

// DynamoDB setup (same as photo upload)
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
        console.log('Post created successfully.');
    } catch (error) {
        console.error('Error creating post:', error);
        throw error;
    }
}

// Endpoint to upload a video to a Facebook page
router.post('/upload-videoV1', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded.' });
    }

    let video_id;
    const accessToken = req.accessToken;
    const pageId = process.env.PAGE_ID;

    try {
        // Extract all fields from req.body
        const videoTitle = req.body.title || '';
        const videoDescription = req.body.description || '';
        const campaignTitle = req.body.campaignTitle || '';
        const campaignLink = req.body.campaignLink || 'https://www.iendorse.ng/';
        const campaignTargetAudienceAnswer = req.body.campaignTargetAudienceAnswer || '#iEndorse';

        // Create postId and timestamp
        const postId = uuidv4();
        const timestamp = Date.now();

        // Construct the message string
        const message = `
${videoTitle}
${videoDescription}
${campaignTitle}
${campaignLink}
${campaignTargetAudienceAnswer}
`;

        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('file', fs.createReadStream(req.file.path));
        formData.append('description', message);

        // Use video upload endpoint
        const url = `https://graph.facebook.com/v19.0/${pageId}/videos`;
        const response = await axios.post(url, formData, {
            headers: { 
                ...formData.getHeaders(),
                'Content-Type': 'multipart/form-data'
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        if (response.status !== 200) {
            console.error('Facebook API error:', response.data);
            return res.status(500).json({ error: 'Facebook API error' });
        }

        video_id = response.data.id;

        // Store video information in DynamoDB
        const postData = {
            pageId: pageId,
            timestamp: timestamp,
            postId: postId,
            videoId: video_id,
            type: 'video',
            videoTitle: videoTitle,
            videoDescription: videoDescription,
            campaignTitle: campaignTitle,
            campaignLink: campaignLink,
            campaignTargetAudienceAnswer: campaignTargetAudienceAnswer,
            message: message
        };

        await createPost(postData);

        return res.status(200).json({ id: video_id, message: 'Video uploaded successfully.' });

    } catch (error) {
        console.error('Error uploading video:', error.response ? error.response.data : error.message);
        return res.status(500).json({ error: 'Failed to upload video to Facebook.' });
    } finally {
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path);
        }
    }
});

module.exports = router;