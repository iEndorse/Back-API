const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // For generating unique IDs - npm install uuid

const router = express.Router(); // Create a router instance

// Load environment variables
//const accessToken = process.env.ACCESS_TOKEN;
const pageId = process.env.PAGE_ID;



// Multer setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// DynamoDB setup is now outside the route handler to avoid re-initialization
const AWS = require('aws-sdk');
AWS.config.update({
    region: 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = 'FacebookPosts'; // Replace with your table name

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

// Endpoint to upload a photo to a Facebook page
router.post('/upload-photoV1', upload.single('photo'), async (req, res) => {
    
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    let photo_id;
    const accessToken = req.accessToken;
    console.log("access", accessToken);
    try {
        // Extract all fields from req.body
        const photoTitle = req.body.title || '';
        const photoDescription = req.body.description || '';
        const campaignTitle = req.body.campaignTitle || '';
        const campaignLink = req.body.campaignLink || 'https://www.iendorse.ng/';
        const campaignTargetAudienceAnswer = req.body.campaignTargetAudienceAnswer || '';

        // Create postId and timestamp
        const postId = uuidv4(); // Generate a unique post ID
        const timestamp = Date.now(); // Get the current timestamp

        // Construct the message string
        const message = `
${photoTitle}
${photoDescription}
${campaignTitle}
${campaignLink}
${campaignTargetAudienceAnswer}
`;

        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('file', fs.createReadStream(req.file.path));
        formData.append('message', message);

        const url = `https://graph.facebook.com/v19.0/${pageId}/photos`;
        const response = await axios.post(url, formData, {
            headers: { ...formData.getHeaders() },
        });

        // Log the final form data (before making the API request)
         // console.log('FormData:', formData);

        if (response.status !== 200) {
            console.error('Facebook API error:', response.data);
            return res.status(500).json({ error: 'Facebook API error' });
        }

        photo_id = response.data.id;

        // Store photo information in DynamoDB
        const postData = {
            pageId: pageId, // Make sure you have the correct pageId value
            timestamp: timestamp,
            postId: postId,
            photoId: photo_id,
            type: 'image', // Correct the type to match the endpoint
            photoTitle: photoTitle,
            photoDescription: photoDescription,
            campaignTitle: campaignTitle,
            campaignLink: campaignLink,
            campaignTargetAudienceAnswer: campaignTargetAudienceAnswer,
            message: message
        };

        await createPost(postData);

        return res.status(200).json({ id: photo_id, message: 'Photo uploaded successfully.' });

    } catch (error) {
        console.error('Error uploading photo:', error.response ? error.response.data : error.message);
        // Only unlink the file if there was an error *before* the DynamoDB operation
        return res.status(500).json({ error: 'Failed to upload photo to Facebook.' });
    } finally {
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path);
        }
    }
});

module.exports = router;