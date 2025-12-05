

// routes/videoToAiAd.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = (() => {
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
})();
const { OpenAI } = require('openai');

const router = express.Router();

// ---------- CONFIG ----------
const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Multer upload config
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 300 * 1024 * 1024, // 300MB
  },
});

// ---------- UTILS ----------
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

async function getMediaDuration(filePath) {
  const cmd =
    `ffprobe -v error -show_entries format=duration ` +
    `-of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  const { stdout } = await execPromise(cmd);
  const dur = parseFloat(stdout.trim());
  if (Number.isNaN(dur)) throw new Error('Could not read duration');
  return dur;
}

function safePath(p) {
  return p.replace(/'/g, "'\\''");
}

// ---------- STEP 1: EXTRACT AUDIO ----------
async function extractAudio(inputVideoPath) {
  const outPath = path.join(TEMP_DIR, `audio_${Date.now()}.wav`);
  const cmd = `ffmpeg -y -i "${inputVideoPath}" -vn -ac 1 -ar 16000 -f wav "${outPath}"`;
  await execPromise(cmd);
  return outPath;
}

// ---------- STEP 2: TRANSCRIBE AUDIO ----------
async function transcribeAudio(audioPath) {
  const fileStream = fs.createReadStream(audioPath);

  // Depending on your OpenAI account, use "whisper-1" or updated ASR model
  const resp = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: fileStream,
    response_format: 'json',
  });

  return resp.text; // full transcript
}

// ---------- STEP 3: BUILD AD SCRIPT FROM TRANSCRIPT ----------
async function buildAdScriptFromTranscript(transcript, brandName, goal) {
  const prompt = `
You are a creative video ad script writer.

Turn the following raw transcript into a polished 30–45 second vertical video ad script.

Requirements:
- Hook strongly in the first line.
- Focus on benefits, clarity, and emotion.
- End with a strong call-to-action.
- Output 6–10 short lines.
- Format exactly like this:

[Beat 1]
First line...

[Beat 2]
Second line...

...and so on.

Brand name: ${brandName || 'Brand'}
Goal of the video: ${goal || 'Get more customers'}

Transcript:
${transcript}
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
  });

  return completion.choices[0].message.content.trim();
}

// ---------- HELPER: PARSE BEATS ----------
function parseBeatsFromScript(scriptText) {
  const lines = scriptText.split('\n');
  const beats = [];
  let currentBeat = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const beatMatch = line.match(/^\[Beat\s+(\d+)\]/i);
    if (beatMatch) {
      if (currentBeat && currentBeat.text.trim()) {
        beats.push(currentBeat);
      }
      currentBeat = { index: parseInt(beatMatch[1], 10), text: '' };
    } else if (currentBeat) {
      currentBeat.text += (currentBeat.text ? ' ' : '') + line;
    }
  }

  if (currentBeat && currentBeat.text.trim()) {
    beats.push(currentBeat);
  }

  // fallback: if no [Beat] markers parsed, treat whole script as 1 beat
  if (beats.length === 0 && scriptText.trim()) {
    beats.push({ index: 1, text: scriptText.trim() });
  }

  return beats;
}

// ---------- STEP 4: GENERATE VOICEOVER ----------
async function generateVoiceOver(scriptText, voiceStyle) {
  const outPath = path.join(TEMP_DIR, `voice_${Date.now()}.mp3`);

  const result = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: voiceStyle || 'alloy',
    format: 'mp3',
    input: scriptText,
  });

  const buffer = Buffer.from(await result.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// ---------- STEP 5: BUILD BEAT TIMINGS ----------
async function buildBeatTimings(beats, voicePath) {
  const totalDuration = await getMediaDuration(voicePath);
  const wordCounts = beats.map((b) => b.text.split(/\s+/).filter(Boolean).length);
  const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;

  let currentTime = 0;
  return beats.map((beat, idx) => {
    const portion = wordCounts[idx] / totalWords;
    // avoid 0-duration segments
    const beatDuration = Math.max(totalDuration * portion, 0.8); // at least 0.8s
    const start = currentTime;
    let end = currentTime + beatDuration;
    if (idx === beats.length - 1) end = totalDuration; // ensure last beat ends at audio end
    currentTime = end;
    return {
      ...beat,
      start,
      end,
      duration: end - start,
    };
  });
}

// ---------- STEP 6: BUILD SUBTITLES (SRT) ----------
function formatSrtTime(sec) {
  const ms = Math.floor((sec % 1) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, '0')}`;
}

async function buildSrtFromBeats(beatTimings) {
  let srt = '';
  beatTimings.forEach((b, i) => {
    srt += `${i + 1}\n`;
    srt += `${formatSrtTime(b.start)} --> ${formatSrtTime(b.end)}\n`;
    srt += `${b.text}\n\n`;
  });

  const outPath = path.join(TEMP_DIR, `captions_${Date.now()}.srt`);
  fs.writeFileSync(outPath, srt, 'utf8');
  return outPath;
}

// ---------- STEP 7: GENERATE PER-BEAT CLIPS WITH SIMPLE KEN BURNS ----------
async function generateBeatClips(inputVideoPath, beatTimings, aspectRatio = '9:16') {
  const isVertical = aspectRatio === '9:16';
  const targetW = isVertical ? 1080 : 1920;
  const targetH = isVertical ? 1920 : 1080;

  const originalDuration = await getMediaDuration(inputVideoPath);

  const beatClipPaths = [];

  for (let i = 0; i < beatTimings.length; i++) {
    const beat = beatTimings[i];

    // Choose a starting offset inside the video (loop if necessary)
    const offset = (i * 3) % Math.max(originalDuration - 1, 1); // every beat jumps 3s

    const outPath = path.join(TEMP_DIR, `beat_${i + 1}_${Date.now()}.mp4`);

    // Simple zoompan for Ken Burns style
    // Randomize slight zoom direction with index
    const zoomExpr = i % 2 === 0
      ? "min(zoom+0.0008,1.3)"
      : "min(zoom+0.0006,1.25)";

    const vf = [
      `scale=${targetW}:-2:force_original_aspect_ratio=increase`,
      `crop=${targetW}:${targetH}`,
      `zoompan=z='${zoomExpr}':d=25`,
    ].join(',');

    const cmd = [
      'ffmpeg',
      '-y',
      `-ss ${beat.start.toFixed(2)}`, // align rough content to audio beat
      `-i "${inputVideoPath}"`,
      `-t ${beat.duration.toFixed(2)}`,
      `-vf "${vf}"`,
      '-an',
      ` "${outPath}"`,
    ].join(' ');

    await execPromise(cmd);
    beatClipPaths.push(outPath);
  }

  return beatClipPaths;
}

// ---------- STEP 8: CONCAT CLIPS + VOICE ----------
async function concatBeatsWithVoice(beatClipPaths, voicePath) {
  const listPath = path.join(TEMP_DIR, `concat_${Date.now()}.txt`);
  const lines = beatClipPaths.map((p) => `file '${safePath(p)}'`);
  fs.writeFileSync(listPath, lines.join('\n'));

  const outPath = path.join(TEMP_DIR, `raw_video_${Date.now()}.mp4`);

  const cmd = [
    'ffmpeg',
    '-y',
    '-f concat',
    '-safe 0',
    `-i "${listPath}"`,
    `-i "${voicePath}"`,
    '-c:v libx264',
    '-c:a aac',
    '-shortest',
    '-pix_fmt yuv420p',
    '-movflags +faststart',
    `"${outPath}"`,
  ].join(' ');

  await execPromise(cmd);
  return outPath;
}

// ---------- STEP 9: ADD SUBTITLES ----------
async function burnSubtitles(inputVideoPath, srtPath) {
  const outPath = path.join(TEMP_DIR, `final_${Date.now()}.mp4`);
  const cmd = [
    'ffmpeg',
    '-y',
    `-i "${inputVideoPath}"`,
    `-vf "subtitles='${safePath(srtPath)}'"`,
    '-c:a copy',
    `"${outPath}"`,
  ].join(' ');

  await execPromise(cmd);
  return outPath;
}

// ---------- MAIN ROUTE ----------
router.post(
  '/ai/creatives/video-to-ai-ad',
  upload.single('video'),
  async (req, res) => {
    const videoFile = req.file;
    const { brandName, goal, voiceStyle } = req.body || {};

    if (!videoFile) {
      return res.status(400).json({ success: false, error: 'No video file uploaded' });
    }

    const inputVideoPath = videoFile.path;

    try {
      // 1. Audio extraction
      const audioPath = await extractAudio(inputVideoPath);

      // 2. Transcription
      const transcript = await transcribeAudio(audioPath);

      // 3. Script
      const script = await buildAdScriptFromTranscript(transcript, brandName, goal);

      // 4. Parse beats
      const beats = parseBeatsFromScript(script);

      // 5. Voiceover
      const voicePath = await generateVoiceOver(
        beats.map((b) => b.text).join('\n'),
        voiceStyle
      );

      // 6. Beat timings
      const beatTimings = await buildBeatTimings(beats, voicePath);

      // 7. Subtitles file
      const srtPath = await buildSrtFromBeats(beatTimings);

      // 8. Per-beat clips with simple Ken Burns
      const beatClipPaths = await generateBeatClips(inputVideoPath, beatTimings, '9:16');

      // 9. Concat beats with voice
      const rawVideoPath = await concatBeatsWithVoice(beatClipPaths, voicePath);

      // 10. Burn subtitles
      const finalVideoPath = await burnSubtitles(rawVideoPath, srtPath);

      // 11. TODO: Upload to S3 and clean temp files
      // const s3Url = await uploadToS3(finalVideoPath);
      // cleanupTemp([...])

      // For now, just return local path for testing
      return res.json({
        success: true,
        script,
        beats: beatTimings.map(({ index, text, start, end }) => ({
          index,
          text,
          start,
          end,
        })),
        finalVideoPath,
        // videoUrl: s3Url, // later
      });
    } catch (err) {
      console.error('video-to-ai-ad error:', err);
      return res
        .status(500)
        .json({ success: false, error: err.message || 'Internal server error' });
    }
  }
);

module.exports = router;



