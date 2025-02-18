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

// Endpoint to upload a video to a Facebook page
router.post('/upload-videoV1', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
        // Extract all fields from req.body
        const videoTitle = req.body.title || 'Default Video Title';
        const videoDescription = req.body.description || 'Default Video Description';
        const campaignTitle = req.body.campaignTitle || '';
        const campaignLink = req.body.campaignLink || 'https://www.iendorse.ng/';
        const campaignTargetAudienceAnswer = req.body.campaignTargetAudienceAnswer || '#iEndorse'; //treat as plain text

        // Construct the full description string
        let fullDescription = `
${videoTitle}
${videoDescription}
${campaignTitle}
${campaignLink}
${campaignTargetAudienceAnswer}
`;

        const url = `https://graph.facebook.com/v19.0/${pageId}/videos`;
        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('file', fs.createReadStream(req.file.path));
        formData.append('description', fullDescription); // Combined information

        const response = await axios.post(url, formData, {
            headers: { ...formData.getHeaders() },
        });

        fs.unlinkSync(req.file.path);

        return res.status(200).json({ id: response.data.id, message: 'Video uploaded successfully.' });
    } catch (error) {
        console.error('Error uploading video:', error.response ? error.response.data : error.message);
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path); // Ensure file exists before unlinking
        }
        return res.status(500).json({ error: 'Failed to upload video to Facebook.' });
    }
});

module.exports = router;