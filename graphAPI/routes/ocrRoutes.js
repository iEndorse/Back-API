const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { RekognitionClient, DetectTextCommand } = require("@aws-sdk/client-rekognition");

const router = express.Router();

// --- AWS Setup ---
const rekognitionClient = new RekognitionClient({
    region: process.env.AWS_REGION || "us-east-1",
});

// --- Multer Setup ---
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) { try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (err) { console.error(`Error creating uploads dir: ${err}`); } }
const upload = multer({ dest: uploadsDir });

// --- Helpers ---
function normalizeNumber(raw) {
    try {
        const str = String(raw).toLowerCase().replace(/,/g, '');
        if (str.includes('k')) return Math.round(parseFloat(str) * 1000);
        if (str.includes('m')) return Math.round(parseFloat(str) * 1000000);
        if (!isNaN(parseFloat(str)) && isFinite(str)) { return parseInt(str, 10); }
        return null;
    } catch (e) { console.error(`Error normalizing number: ${raw}`, e); return null; }
}

const numberPattern = /^\d{1,3}(?:,\d{3})*(?:\.\d+)?[kKmM]?$/i;
const keywords = {
    comments: /comments?|comment|cmt|cmts|replies|reply/i, // Added replies
    shares: /shares?|share/i,
    reposts: /reposts?|repost/i,
    views: /views?|view/i,
};
const keywordRegex = new RegExp(`\\b(${Object.values(keywords).map(r => r.source).join('|')})\\b`, 'i');
const saveKeywords = /bookmark|save|🔖/i;

function areVerticallyAligned(box1, box2, tolerance = 0.04) {
    const center1 = box1.Top + box1.Height / 2;
    const center2 = box2.Top + box2.Height / 2;
    return Math.abs(center1 - center2) < tolerance;
}
function areHorizontallyAligned(box1, box2, tolerance = 0.04) { // Checks if Left edges are close
    const center1 = box1.Left + box1.Width / 2;
    const center2 = box2.Left + box2.Width / 2;
    return Math.abs(center1 - center2) < tolerance;
}

function isNumberNearKeyword(numBox, keyBox, maxGap = 0.04, verticalTolerance = 0.04) {
    if (!areVerticallyAligned(numBox, keyBox, verticalTolerance)) return false;
    const numRightEdge = numBox.Left + numBox.Width;
    const gap = keyBox.Left - numRightEdge;
    return gap >= -0.01 && gap < maxGap;
}

// --- Function to find the dominant interaction cluster and its orientation ---
function findInteractionCluster(numbers, verticalAlignTolerance = 0.05, horizontalAlignTolerance = 0.05) {
    if (!numbers || numbers.length === 0) {
        return { cluster: [], orientation: 'unknown' };
    }
    if (numbers.length === 1) {
         // Cannot determine orientation from a single point
         return { cluster: numbers, orientation: 'unknown' };
    }

    // Try Horizontal Clustering (Group by similar Top coordinate)
    const topGroups = numbers.reduce((acc, num) => {
        const topKey = num.box.Top.toFixed(2); // Group by rounded Top
        if (!acc[topKey]) acc[topKey] = [];
        acc[topKey].push(num);
        return acc;
    }, {});

    let bestHorizontalCluster = [];
    for (const topKey in topGroups) {
        if (topGroups[topKey].length > bestHorizontalCluster.length) {
            bestHorizontalCluster = topGroups[topKey];
        }
    }

    // Try Vertical Clustering (Group by similar Left coordinate)
    const leftGroups = numbers.reduce((acc, num) => {
        const leftKey = num.box.Left.toFixed(2); // Group by rounded Left
        if (!acc[leftKey]) acc[leftKey] = [];
        acc[leftKey].push(num);
        return acc;
    }, {});

    let bestVerticalCluster = [];
    for (const leftKey in leftGroups) {
        if (leftGroups[leftKey].length > bestVerticalCluster.length) {
            bestVerticalCluster = leftGroups[leftKey];
        }
    }

    // Determine dominant orientation
    // Consider a cluster "dominant" if it contains significantly more items OR
    // if lengths are equal, prefer horizontal as it's more common.
    if (bestHorizontalCluster.length >= 2 && bestHorizontalCluster.length >= bestVerticalCluster.length) {
        console.log(`[Cluster] Detected Horizontal Cluster (Size: ${bestHorizontalCluster.length})`);
        return { cluster: bestHorizontalCluster.sort((a, b) => a.box.Left - b.box.Left), orientation: 'horizontal' };
    } else if (bestVerticalCluster.length >= 2) {
        console.log(`[Cluster] Detected Vertical Cluster (Size: ${bestVerticalCluster.length})`);
        return { cluster: bestVerticalCluster.sort((a, b) => a.box.Top - b.box.Top), orientation: 'vertical' };
    } else {
        // If no clear cluster, return all numbers sorted horizontally as default
        console.log("[Cluster] No clear dominant cluster found, using horizontal fallback.");
        return { cluster: numbers.sort((a, b) => a.box.Left - b.box.Left), orientation: 'horizontal_fallback' };
    }
}


// --- OCR Endpoint ---
router.post('/aws', upload.single('image'), async (req, res) => {
    // ... (file check) ...
    if (!req.file) { return res.status(400).json({ error: 'No image file uploaded.' }); }
    const imagePath = req.file.path;
    console.log(`Processing image (adaptive v4 - Layout Aware): ${imagePath}`);

    try {
        const fileBuffer = fs.readFileSync(imagePath);
        const command = new DetectTextCommand({ Image: { Bytes: fileBuffer } });
        console.log("Sending image to AWS Rekognition...");
        const data = await rekognitionClient.send(command);
        console.log("Received response from AWS Rekognition.");

        const textDetections = data.TextDetections || [];
        let detectedNumbers = [];
        let detectedKeywords = [];
        let allWords = [];

        // --- Pass 1: Categorize Detections ---
        textDetections.forEach(detection => {
            // ... (same categorization logic as v3) ...
             if (detection.Type === 'WORD' && detection.DetectedText && detection.Geometry?.BoundingBox) {
                const text = detection.DetectedText;
                const box = detection.Geometry.BoundingBox;
                allWords.push({ text, box });

                if (numberPattern.test(text)) {
                    const value = normalizeNumber(text);
                    if (value !== null && value >= 0) {
                        detectedNumbers.push({ text, value, box, used: false, confidence: detection.Confidence });
                    }
                } else if (keywordRegex.test(text)) {
                    for (const key in keywords) {
                        if (keywords[key].test(text)) {
                            // Special handling for 'replies' -> map to 'comments' type
                            const type = (key === 'comments' && /replies|reply/i.test(text)) ? 'comments' : key;
                            detectedKeywords.push({ text, type: type, box, used: false, confidence: detection.Confidence });
                            break;
                        }
                    }
                }
            }
        });

        console.log("Detected Numbers:", detectedNumbers.map(n => ({ t: n.text, v: n.value, l: n.box.Left.toFixed(4), top: n.box.Top.toFixed(4) })));
        console.log("Detected Keywords:", detectedKeywords.map(k => ({ t: k.text, ty: k.type, l: k.box.Left.toFixed(4), top: k.box.Top.toFixed(4) })));


        let results = {
            reactions: 'Not found', comments: 'Not found', shares: 'Not found',
            reposts: 'Not found', views: 'Not found', saves: 'Not found',
            // Add potential fields for lower confidence assignments
            potential_comments: 'Not found', potential_shares: 'Not found',
            potential_bookmarks: 'Not found', // For vertical layout (TikTok saves)
            debug_layout_orientation: 'unknown', // Add detected layout info
            provider: "AWS Rekognition (Adaptive v4)"
        };

        // --- Pass 2: Associate Keywords with Numbers (Highest Confidence) ---
        // ... (same keyword association logic as v3) ...
        detectedKeywords.sort((a, b) => a.box.Left - b.box.Left);
        detectedKeywords.forEach(keyword => {
            if (keyword.used) return;
            let bestMatchNum = null; let minDistance = Infinity;
            detectedNumbers.forEach(number => {
                if (!number.used && isNumberNearKeyword(number.box, keyword.box)) {
                    const distance = keyword.box.Left - (number.box.Left + number.box.Width);
                    if (distance < minDistance) { minDistance = distance; bestMatchNum = number; }
                }
            });
            if (bestMatchNum) {
                console.log(`[Keyword Match] Associating: ${keyword.text} (${keyword.type}) with ${bestMatchNum.text}`);
                if (keyword.type === 'reposts') { results.reposts = bestMatchNum.value; results.shares = bestMatchNum.value; }
                else if (keyword.type === 'comments') { results.comments = bestMatchNum.value;} // Assign directly now
                else { results[keyword.type] = bestMatchNum.value; }
                keyword.used = true; bestMatchNum.used = true;
            } else { console.log(`[Keyword Match] No number found near keyword: ${keyword.text}`); }
        });

        // --- Pass 3: Positional Heuristics based on Cluster Orientation ---
        const unusedNumbers = detectedNumbers.filter(n => !n.used);
        if (unusedNumbers.length > 0) {
            console.log("[Positional Analysis] Analyzing unused numbers:", unusedNumbers.map(n => n.text));
            const { cluster, orientation } = findInteractionCluster(unusedNumbers);
            results.debug_layout_orientation = orientation; // Store detected orientation

            if (cluster.length > 0) {
                console.log(`[Positional Analysis] Using ${orientation} layout for cluster:`, cluster.map(n=>n.text));

                if (orientation === 'horizontal' || orientation === 'horizontal_fallback') {
                    // --- Horizontal Assignment (Instagram, FB, LinkedIn, X) ---
                    if (cluster.length > 0 && !cluster[0].used) {
                        console.log(`[Positional H] Assigning reactions (L->R 1st): ${cluster[0].text}`);
                        results.reactions = cluster[0].value; cluster[0].used = true;
                    }
                    if (cluster.length > 1 && !cluster[1].used && results.comments === 'Not found') { // Only if comments not found by keyword
                        console.log(`[Positional H] Assigning potential_comments (L->R 2nd): ${cluster[1].text}`);
                        results.potential_comments = cluster[1].value; cluster[1].used = true;
                    }
                    if (cluster.length > 2 && !cluster[2].used && results.shares === 'Not found' && results.reposts === 'Not found') { // Only if shares/reposts not found
                        console.log(`[Positional H] Assigning potential_shares (L->R 3rd): ${cluster[2].text}`);
                        results.potential_shares = cluster[2].value; cluster[2].used = true;
                    }
                     // X/Twitter note: reactions field likely holds Replies count here.

                } else if (orientation === 'vertical') {
                    // --- Vertical Assignment (TikTok) ---
                     if (cluster.length > 0 && !cluster[0].used) {
                        console.log(`[Positional V] Assigning reactions (Top->Bot 1st): ${cluster[0].text}`);
                        results.reactions = cluster[0].value; cluster[0].used = true; // TikTok Likes
                    }
                     if (cluster.length > 1 && !cluster[1].used && results.comments === 'Not found') {
                        console.log(`[Positional V] Assigning potential_comments (Top->Bot 2nd): ${cluster[1].text}`);
                        results.potential_comments = cluster[1].value; cluster[1].used = true; // TikTok Comments
                    }
                     if (cluster.length > 2 && !cluster[2].used && results.saves === 'Not found') {
                        console.log(`[Positional V] Assigning potential_bookmarks (Top->Bot 3rd): ${cluster[2].text}`);
                        results.potential_bookmarks = cluster[2].value; cluster[2].used = true; // TikTok Saves/Bookmarks
                    }
                     if (cluster.length > 3 && !cluster[3].used && results.shares === 'Not found' && results.reposts === 'Not found') {
                        console.log(`[Positional V] Assigning potential_shares (Top->Bot 4th): ${cluster[3].text}`);
                        results.potential_shares = cluster[3].value; cluster[3].used = true; // TikTok Shares
                    }
                }
            } else {
                 console.log("[Positional Analysis] No usable cluster identified.");
            }
        } else {
            console.log("[Positional Analysis] No unused numbers found.");
        }

        // --- Pass 4: Check for Save Icon/Keyword & Associate Nearby Number ---
        const saveDetection = allWords.find(w => saveKeywords.test(w.text));
        if (saveDetection && results.saves === 'Not found') {
            console.log(`[Save Check] Save icon/keyword detected: ${saveDetection.text}`);
            // Try to find the closest unused number (low confidence association)
            let closestUnusedNum = null;
            let minDistSq = Infinity;
            const saveCenter = { x: saveDetection.box.Left + saveDetection.box.Width / 2, y: saveDetection.box.Top + saveDetection.box.Height / 2 };

            detectedNumbers.forEach(num => {
                if (!num.used) {
                    const numCenter = { x: num.box.Left + num.box.Width / 2, y: num.box.Top + num.box.Height / 2 };
                    const distSq = Math.pow(saveCenter.x - numCenter.x, 2) + Math.pow(saveCenter.y - numCenter.y, 2);
                    // Check if it's reasonably close (e.g., within 10% of image width/height squared)
                    if (distSq < 0.01 && distSq < minDistSq) {
                        minDistSq = distSq;
                        closestUnusedNum = num;
                    }
                }
            });

            if (closestUnusedNum) {
                console.log(`[Save Check] Associating nearby number ${closestUnusedNum.text} with save icon (Low Confidence).`);
                results.saves = closestUnusedNum.value;
                closestUnusedNum.used = true; // Mark as used
            } else {
                 results.saves = 'Icon/Keyword Detected'; // No nearby number found
            }
        }

        // --- Clean up and Respond ---
        fs.unlink(imagePath, (err) => { /* ... error handling ... */ });
        res.json(results);

    } catch (err) {
        // ... (error handling) ...
        console.error('AWS ADAPTIVE OCR V4 ERROR:', err);
        if (fs.existsSync(imagePath)) { fs.unlink(imagePath, (unlinkErr) => { if (unlinkErr) console.error(`Error deleting temp file ${imagePath} after error:`, unlinkErr); }); }
        res.status(500).json({ provider: "AWS Rekognition (Adaptive v4)", error: err.message || 'An unknown error occurred.' });
    }
});

module.exports = router;