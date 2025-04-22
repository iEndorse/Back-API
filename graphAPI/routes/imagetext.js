const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

const router = express.Router();

// Upload directory
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const upload = multer({ dest: uploadsDir });

// Utility to normalize "K", "M", and commas
function normalizeNumber(raw) {
  const str = raw.toLowerCase().replace(/,/g, '');
  if (str.includes('k')) return Math.round(parseFloat(str) * 1000);
  if (str.includes('m')) return Math.round(parseFloat(str) * 1000000);
  return parseInt(str, 10);
}

// OCR endpoint
router.post('/ocr', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const imagePath = req.file.path;

  try {
    const result = await Tesseract.recognize(imagePath, 'eng');
    const text = result.data.text;

    // Match various interactions (with K/M/commas supported)
    const reactionMatch = text.match(/(\d[\d.,]*[kKmM]?)\s*(reactions?|likes?|hearts?|love|haha|angry)/i);
    const commentMatch = text.match(/(\d[\d.,]*[kKmM]?)\s*comments?/i);
    const shareMatch = text.match(/(\d[\d.,]*[kKmM]?)\s*shares?/i);
    const saveMatch = text.match(/(\d[\d.,]*[kKmM]?)\s*saves?/i);

    // Delete uploaded file after processing
    fs.unlinkSync(imagePath);

    res.json({
      extractedText: text,
      reactions: reactionMatch ? normalizeNumber(reactionMatch[1]) : 'Not found',
      comments: commentMatch ? normalizeNumber(commentMatch[1]) : 'Not found',
      shares: shareMatch ? normalizeNumber(shareMatch[1]) : 'Not found',
      saves: saveMatch ? normalizeNumber(saveMatch[1]) : 'Not found',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;