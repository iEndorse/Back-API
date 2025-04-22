const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
require('dotenv').config();

const router = express.Router();

// Set up uploads directory
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({ dest: uploadsDir });

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post('/openai', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const imagePath = req.file.path;
  const mimeType = req.file.mimetype || 'image/jpeg';
  const imageBase64 = fs.readFileSync(imagePath, { encoding: 'base64' });

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o', 
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that extracts social media post metrics from images.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are analyzing a screenshot of a social media post.
Extract the number of reactions (likes, love, haha, wow, etc.), comments, shares, and saves.
Return your response in this exact JSON format:
{ "reactions": <number>, "comments": <number>, "shares": <number>, "views": <number>,"saves": <number> }

If a value is not visible, write "unknown".`,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 150,
    });

    fs.unlinkSync(imagePath); // Clean up

    const reply = response.choices[0].message.content;

    // Extract JSON block from reply
    const jsonMatch = reply.match(/\{[\s\S]*?\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: reply };

    res.json({ result });
  } catch (err) {
    console.error('OpenAI Error:', err);
    res.status(500).json({ error: 'Failed to process image with OpenAI.' });
  }
});

module.exports = router;
