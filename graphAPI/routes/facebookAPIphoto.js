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
 // Use the variables in your route logic
 if (!accessToken || !pageId) {
    return res.status(500).json({ error: 'Missing required environment variables' });
  }

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

// Endpoint to upload a photo to a Facebook page
router.post('/upload-photo', upload.single('photo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
       
        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('file', fs.createReadStream(req.file.path));
        formData.append('message', "req.body.message" || '');

        const url = `https://graph.facebook.com/v19.0/${pageId}/photos`;
        const response = await axios.post(url, formData, {
            headers: { ...formData.getHeaders() },
        });

        console.log(accessToken)
// Log the final form data (before making the API request)
console.log('FormData:', formData);
        fs.unlinkSync(req.file.path);

        return res.status(200).json({ id: response.data.id, message: 'Photo uploaded successfully.' });
    } catch (error) {
        console.error('Error uploading photo:', error.response ? error.response.data : error.message);
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ error: 'Failed to upload photo to Facebook.' });
    }
});

module.exports = router;
