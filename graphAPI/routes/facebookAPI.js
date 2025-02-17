const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { fileTypeFromStream } = require('file-type');

const router = express.Router(); // Create a router instance

// Load environment variables
const accessToken = process.env.ACCESS_TOKEN; // Get access token from .env
const pageId = process.env.PAGE_ID; // Get page ID from .env

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

// Combined endpoint for handling both images and videos
router.post('/:page_id/media', upload.single('media_file'), async (req, res) => {
    const page_id = req.params.page_id; //Getting from parameter 
    const access_token = accessToken; // Get from .env
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
        const fileStream = fs.createReadStream(file.path);
        const fileTypeResult = await fileTypeFromStream(fileStream);
        let fileType = fileTypeResult ? fileTypeResult.mime : null;

        if (!fileType) {
            const extname = path.extname(file.originalname).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif', '.bmp'].includes(extname)) {
                fileType = 'image';
            } else if (['.mp4', '.mov', '.avi', '.wmv', '.flv', '.webm'].includes(extname)) {
                fileType = 'video';
            }
        }

        if (!fileType) {
            fs.unlinkSync(file.path);
            return res.status(400).json({ error: 'Could not determine file type.' });
        }

        if (fileType.startsWith('image/')) {
            const album_id = req.query.album_id;
            const message = req.query.message;
            await uploadImage(page_id, access_token, file, album_id, message, res);

        } else if (fileType.startsWith('video/')) {
            const title = req.body.title;
            const description = req.body.description;

            if (!title || !description) {
                fs.unlinkSync(file.path);
                return res.status(400).json({ error: 'Title and description are required for videos.' });
            }
            await uploadVideo(page_id, access_token, file, title, description, res);

        } else {
            fs.unlinkSync(file.path);
            return res.status(400).json({ error: 'Unsupported file type.' });
        }

    } catch (error) {
        console.error('Error processing media:', error);
        fs.unlinkSync(file.path);
        return res.status(500).json({ error: error.message });
    }
});

// Function to upload an image
async function uploadImage(page_id, access_token, file, album_id, message, res) {
    try {
        const url = `https://graph.facebook.com/v19.0/${page_id}/photos`;

        const formData = new FormData();
        formData.append('access_token', access_token);
        formData.append('file', fs.createReadStream(file.path));
        formData.append('message', message);

        if (album_id) {
            formData.append('album_id', album_id);
        }

        const response = await axios.post(url, formData, {
            headers: {
                ...formData.getHeaders(),
            },
        });

        fs.unlinkSync(file.path);

        if (response.status !== 200) {
            console.error('Facebook API error:', response.data);
            return res.status(500).json({ error: 'Facebook API error' });
        }

        const photo_id = response.data.id;

        return res.status(200).json({
            id: photo_id,
            type: 'image',
        }).end();

    } catch (error) {
        console.error('Error uploading image:', error);
        if (error.response) {
            console.error('Facebook API error details:', error.response.data);
        }
        fs.unlinkSync(file.path);
        return res.status(500).json({ error: error.message });
    }
}

// Function to upload a video
async function uploadVideo(page_id, access_token, file, title, description, res) {
    try {
        const url = `https://graph.facebook.com/v19.0/${page_id}/videos`;

        const formData = new FormData();
        formData.append('access_token', access_token);
        formData.append('title', title);
        formData.append('description', description);
        formData.append('video_file', fs.createReadStream(file.path));

        const response = await axios.post(url, formData, {
            headers: {
                ...formData.getHeaders(),
            },
        });

        fs.unlinkSync(file.path);

        if (response.status !== 200) {
            console.error('Facebook API error:', response.data);
            return res.status(500).json({ error: 'Facebook API error' });
        }

        const video_id = response.data.id;

        return res.status(200).json({
            id: video_id,
            type: 'video',
        }).end();

    } catch (error) {
        console.error('Error uploading video:', error);
        if (error.response) {
            console.error('Facebook API error details:', error.response.data);
        }
        fs.unlinkSync(file.path);
        return res.status(500).json({ error: error.message });
    }
}

module.exports = router; // Export the router