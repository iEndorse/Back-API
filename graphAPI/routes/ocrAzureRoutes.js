const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
// Import Azure SDK v4 Image Analysis client
const { ImageAnalysisClient, VisualFeatures } = require('@azure/ai-vision-image-analysis');
const { AzureKeyCredential } = require('@azure/core-auth'); // For key authentication

const router = express.Router();

// --- Azure Computer Vision Setup ---
const endpoint = process.env.AZURE_VISION_ENDPOINT;
const key = process.env.AZURE_VISION_KEY;

if (!endpoint || !key) {
    console.error("Azure Vision Endpoint or Key not configured. Set AZURE_VISION_ENDPOINT and AZURE_VISION_KEY environment variables.");
}
// Initialize client only if credentials are available
const visionClient = endpoint && key
    ? new ImageAnalysisClient(endpoint, new AzureKeyCredential(key))
    : null;
// ---------------------------------

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
    comments: /comments?|comment|cmt|cmts|replies|reply/i,
    shares: /shares?|share/i,
    reposts: /reposts?|repost/i,
    views: /views?|view/i,
};
const keywordRegex = new RegExp(`\\b(${Object.values(keywords).map(r => r.source).join('|')})\\b`, 'i');
const saveKeywords = /bookmark|save|🔖/i;

// --- Azure Coordinate Helpers (Using PIXEL coordinates) ---
// Tolerance values are now in pixels and might need tuning based on image sizes
function areVerticallyAlignedAzure(box1, box2, tolerance = 20) { // Pixel tolerance
    const center1Y = (box1[1] + box1[7]) / 2; // Avg of topLeftY and bottomLeftY
    const center2Y = (box2[1] + box2[7]) / 2;
    return Math.abs(center1Y - center2Y) < tolerance;
}

function areHorizontallyAlignedAzure(box1, box2, tolerance = 25) { // Pixel tolerance
    const center1X = (box1[0] + box1[2]) / 2; // Avg of topLeftX and topRightX
    const center2X = (box2[0] + box2[2]) / 2;
    return Math.abs(center1X - center2X) < tolerance;
}

function isNumberNearKeywordAzure(numBox, keyBox, maxGap = 35, verticalTolerance = 20) { // Pixel gaps/tolerance
    if (!areVerticallyAlignedAzure(numBox, keyBox, verticalTolerance)) return false;
    const numRightEdgeX = numBox[2]; // topRightX
    const keyLeftEdgeX = keyBox[0]; // topLeftX
    const gap = keyLeftEdgeX - numRightEdgeX;
    return gap >= -5 && gap < maxGap; // Allow slight overlap (-5px), reasonable gap
}

// --- Function to find the dominant interaction cluster (Azure Coords) ---
function findInteractionClusterAzure(numbers) {
    if (!numbers || numbers.length === 0) return { cluster: [], orientation: 'unknown' };
    if (numbers.length === 1) return { cluster: numbers, orientation: 'unknown' };

    // Try Horizontal Clustering (Group by similar Top Y coordinate)
    const topGroups = numbers.reduce((acc, num) => {
        const topKey = Math.round(num.box[1] / 10) * 10; // Group by Top Y rounded to nearest 10px
        if (!acc[topKey]) acc[topKey] = [];
        acc[topKey].push(num);
        return acc;
    }, {});
    let bestHorizontalCluster = [];
    for (const topKey in topGroups) {
        if (topGroups[topKey].length > bestHorizontalCluster.length) bestHorizontalCluster = topGroups[topKey];
    }

    // Try Vertical Clustering (Group by similar Left X coordinate)
    const leftGroups = numbers.reduce((acc, num) => {
        const leftKey = Math.round(num.box[0] / 10) * 10; // Group by Left X rounded to nearest 10px
        if (!acc[leftKey]) acc[leftKey] = [];
        acc[leftKey].push(num);
        return acc;
    }, {});
    let bestVerticalCluster = [];
    for (const leftKey in leftGroups) {
        if (leftGroups[leftKey].length > bestVerticalCluster.length) bestVerticalCluster = leftGroups[leftKey];
    }

    // Determine dominant orientation
    if (bestHorizontalCluster.length >= 2 && bestHorizontalCluster.length >= bestVerticalCluster.length) {
        console.log(`[Cluster] Detected Horizontal Cluster (Size: ${bestHorizontalCluster.length})`);
        return { cluster: bestHorizontalCluster.sort((a, b) => a.box[0] - b.box[0]), orientation: 'horizontal' }; // Sort by Left X
    } else if (bestVerticalCluster.length >= 2) {
        console.log(`[Cluster] Detected Vertical Cluster (Size: ${bestVerticalCluster.length})`);
        return { cluster: bestVerticalCluster.sort((a, b) => a.box[1] - b.box[1]), orientation: 'vertical' }; // Sort by Top Y
    } else {
        console.log("[Cluster] No clear dominant cluster found, using horizontal fallback.");
        return { cluster: numbers.sort((a, b) => a.box[0] - b.box[0]), orientation: 'horizontal_fallback' };
    }
}

// --- OCR Endpoint ---
router.post('/azure', upload.single('image'), async (req, res) => { // Changed route path
    if (!visionClient) { // Check if client was initialized
        return res.status(503).json({ error: "Azure Vision client not configured." });
    }
    if (!req.file) { return res.status(400).json({ error: 'No image file uploaded.' }); }

    const imagePath = req.file.path;
    console.log(`Processing image with Azure Vision (adaptive v4): ${imagePath}`);

    try {
        const imageBuffer = fs.readFileSync(imagePath);

        // --- Call Azure Vision Read API ---
        console.log("Sending image to Azure Computer Vision...");
        // Use analyze method with image data buffer and specify the Read feature
        const result = await visionClient.analyze(imageBuffer, [VisualFeatures.Read]);
        console.log("Received response from Azure Computer Vision.");
        // --- ------------------------- ---

        let detectedNumbers = [];
        let detectedKeywords = [];
        let allWords = [];

        // --- Pass 1: Categorize Detections from Azure Read Result ---
        if (result.read?.blocks?.length > 0) {
            result.read.blocks.forEach(block => {
                block.lines.forEach(line => {
                    line.words.forEach(word => {
                        const text = word.text;
                        const box = word.boundingBox; // Array [x1,y1, x2,y2, x3,y3, x4,y4] PIXEL COORDS
                        const confidence = word.confidence;

                        allWords.push({ text, box });

                        if (numberPattern.test(text)) {
                            const value = normalizeNumber(text);
                            if (value !== null && value >= 0) {
                                detectedNumbers.push({ text, value, box, used: false, confidence });
                            }
                        } else if (keywordRegex.test(text)) {
                            for (const key in keywords) {
                                if (keywords[key].test(text)) {
                                    const type = (key === 'comments' && /replies|reply/i.test(text)) ? 'comments' : key;
                                    detectedKeywords.push({ text, type: type, box, used: false, confidence });
                                    break;
                                }
                            }
                        }
                    });
                });
            });
        } else {
             console.log("Azure Vision Read API returned no text blocks.");
        }
        // --- --------------------------------------------------- ---

        console.log("Detected Numbers (Azure):", detectedNumbers.map(n => ({ t: n.text, v: n.value, x: n.box[0], y: n.box[1] })));
        console.log("Detected Keywords (Azure):", detectedKeywords.map(k => ({ t: k.text, ty: k.type, x: k.box[0], y: k.box[1] })));

        let results = { /* ... same results object structure ... */
             reactions: 'Not found', comments: 'Not found', shares: 'Not found',
             reposts: 'Not found', views: 'Not found', saves: 'Not found',
             potential_comments: 'Not found', potential_shares: 'Not found',
             potential_bookmarks: 'Not found',
             debug_layout_orientation: 'unknown',
             provider: "Azure Computer Vision (Adaptive v4)" // Updated provider name
         };

        // --- Pass 2: Associate Keywords with Numbers ---
        detectedKeywords.sort((a, b) => a.box[0] - b.box[0]); // Sort keywords by Left X
        detectedKeywords.forEach(keyword => {
            if (keyword.used) return;
            let bestMatchNum = null; let minDistance = Infinity;
            detectedNumbers.forEach(number => {
                // Use the Azure-specific helper function
                if (!number.used && isNumberNearKeywordAzure(number.box, keyword.box)) {
                    const distance = keyword.box[0] - number.box[2]; // keyLeftX - numRightX
                    if (distance < minDistance) { minDistance = distance; bestMatchNum = number; }
                }
            });
            if (bestMatchNum) {
                console.log(`[Keyword Match] Associating: ${keyword.text} (${keyword.type}) with ${bestMatchNum.text}`);
                 if (keyword.type === 'reposts') { results.reposts = bestMatchNum.value; results.shares = bestMatchNum.value; }
                 else if (keyword.type === 'comments') { results.comments = bestMatchNum.value;}
                 else { results[keyword.type] = bestMatchNum.value; }
                 keyword.used = true; bestMatchNum.used = true;
            } else { console.log(`[Keyword Match] No number found near keyword: ${keyword.text}`); }
        });
        // --- ---------------------------------------- ---

        // --- Pass 3: Positional Heuristics based on Cluster Orientation ---
        const unusedNumbers = detectedNumbers.filter(n => !n.used);
        if (unusedNumbers.length > 0) {
            console.log("[Positional Analysis] Analyzing unused numbers:", unusedNumbers.map(n => n.text));
            // Use the Azure-specific cluster finding function
            const { cluster, orientation } = findInteractionClusterAzure(unusedNumbers);
            results.debug_layout_orientation = orientation;

            if (cluster.length > 0) {
                console.log(`[Positional Analysis] Using ${orientation} layout for cluster:`, cluster.map(n=>n.text));
                // Apply assignment logic based on orientation (same logic as before, just uses Azure boxes implicitly now)
                if (orientation === 'horizontal' || orientation === 'horizontal_fallback') {
                    if (cluster.length > 0 && !cluster[0].used) { results.reactions = cluster[0].value; cluster[0].used = true; console.log(`[Pos H] reactions: ${cluster[0].text}`);}
                    if (cluster.length > 1 && !cluster[1].used && results.comments === 'Not found') { results.potential_comments = cluster[1].value; cluster[1].used = true; console.log(`[Pos H] potential_comments: ${cluster[1].text}`); }
                    if (cluster.length > 2 && !cluster[2].used && results.shares === 'Not found' && results.reposts === 'Not found') { results.potential_shares = cluster[2].value; cluster[2].used = true; console.log(`[Pos H] potential_shares: ${cluster[2].text}`); }
                } else if (orientation === 'vertical') {
                    if (cluster.length > 0 && !cluster[0].used) { results.reactions = cluster[0].value; cluster[0].used = true; console.log(`[Pos V] reactions: ${cluster[0].text}`); }
                    if (cluster.length > 1 && !cluster[1].used && results.comments === 'Not found') { results.potential_comments = cluster[1].value; cluster[1].used = true; console.log(`[Pos V] potential_comments: ${cluster[1].text}`); }
                    if (cluster.length > 2 && !cluster[2].used && results.saves === 'Not found') { results.potential_bookmarks = cluster[2].value; cluster[2].used = true; console.log(`[Pos V] potential_bookmarks: ${cluster[2].text}`); }
                    if (cluster.length > 3 && !cluster[3].used && results.shares === 'Not found' && results.reposts === 'Not found') { results.potential_shares = cluster[3].value; cluster[3].used = true; console.log(`[Pos V] potential_shares: ${cluster[3].text}`); }
                }
            } else { console.log("[Positional Analysis] No usable cluster identified."); }
        } else { console.log("[Positional Analysis] No unused numbers found."); }
        // --- ----------------------------------------------------------- ---


        // --- Pass 4: Check for Save Icon/Keyword & Associate Nearby Number ---
        const saveDetection = allWords.find(w => saveKeywords.test(w.text));
        if (saveDetection && results.saves === 'Not found') {
            console.log(`[Save Check] Save icon/keyword detected: ${saveDetection.text}`);
            let closestUnusedNum = null; let minDistSq = Infinity;
            // Calculate center using Azure pixel coordinates
            const saveCenter = { x: (saveDetection.box[0] + saveDetection.box[2]) / 2, y: (saveDetection.box[1] + saveDetection.box[7]) / 2 };

            detectedNumbers.forEach(num => {
                if (!num.used) {
                    const numCenter = { x: (num.box[0] + num.box[2]) / 2, y: (num.box[1] + num.box[7]) / 2 };
                    const distSq = Math.pow(saveCenter.x - numCenter.x, 2) + Math.pow(saveCenter.y - numCenter.y, 2);
                    // Use a pixel-based threshold (e.g., within 50 pixels squared) - ADJUST AS NEEDED
                    if (distSq < (50 * 50) && distSq < minDistSq) {
                        minDistSq = distSq; closestUnusedNum = num;
                    }
                }
            });
            if (closestUnusedNum) {
                console.log(`[Save Check] Associating nearby number ${closestUnusedNum.text} with save icon (Low Confidence).`);
                results.saves = closestUnusedNum.value; closestUnusedNum.used = true;
            } else { results.saves = 'Icon/Keyword Detected'; }
        }
        // --- --------------------------------------------------------------- ---

        // --- Clean up and Respond ---
        fs.unlink(imagePath, (err) => { if (err) console.error(`Error deleting temp file ${imagePath}:`, err); });
        res.json(results);

    } catch (err) {
        console.error('AZURE VISION ADAPTIVE OCR V4 ERROR:', err);
        if (fs.existsSync(imagePath)) { fs.unlink(imagePath, (unlinkErr) => { if (unlinkErr) console.error(`Error deleting temp file ${imagePath} after error:`, unlinkErr); }); }
        res.status(500).json({ provider: "Azure Computer Vision (Adaptive v4)", error: err.message || 'An unknown error occurred.' });
    }
});

module.exports = router;