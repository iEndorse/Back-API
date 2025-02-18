const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Load environment variables
const accessToken = process.env.ACCESS_TOKEN;
const pageId = process.env.PAGE_ID;

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage });

// Use middleware to parse incoming request bodies (important for POST requests)
router.use(express.json());  // For parsing application/json
router.use(express.urlencoded({ extended: true }));  // For parsing application/x-www-form-urlencoded

// Endpoint to upload a video to a Facebook page
router.post('/upload-video2', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
        // Access and parse fields from req.body
        const campaignData = {
            
            campaignTitle: req.body.campaignTitle || "string",
            campaignLink: req.body.campaignLink || "string",
            description: req.body.description || "string",
           campaignTargetAudienceAnswer: req.body.campaignTargetAudienceAnswer ? JSON.parse(req.body.campaignTargetAudienceAnswer) : [], // Parse if sent as JSON string
        };

        // Construct the description string to include all the information
        const description = `
            Category ID: ${campaignData.categoryId}
            Campaign Title: ${campaignData.campaignTitle}
            Campaign Link: ${campaignData.campaignLink}
            Description: ${campaignData.description}
            Age: ${campaignData.age.join(', ')}
            Campaign Media: ${JSON.stringify(campaignData.campaignMedia)}
            Campaign Target Audience: ${JSON.stringify(campaignData.campaignTargetAudienceAnswer)}
        `.trim(); // Trim the description to remove unnecessary spaces/newlines

        // Log the constructed description
        console.log('Constructed Description:', description);

        // Prepare form data for video upload
        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('file', fs.createReadStream(req.file.path));
        formData.append('message', description);  // Ensure message is appended correctly

        // Log the final form data (before making the API request)
        console.log('FormData:', formData);

        // Upload the video to Facebook
        const url = `https://graph.facebook.com/v19.0/${pageId}/videos`;
        const response = await axios.post(url, formData, {
            headers: { ...formData.getHeaders() }
        });

        // Delete the file after uploading
        fs.unlinkSync(req.file.path);

        // Send response with success
        return res.status(200).json({ id: response.data.id, message: 'Video uploaded successfully.' });
    } catch (error) {
        console.error('Error uploading video:', error.response ? error.response.data : error.message);
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ error: 'Failed to upload video to Facebook.' });
    }
});

module.exports = router;
