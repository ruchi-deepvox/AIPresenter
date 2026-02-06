import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import OpenAI, { toFile } from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load API key from root .env (VITE_OPENAI_API_KEY)
const OPENAI_API_KEY = process.env.VITE_OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn('[server] WARNING: VITE_OPENAI_API_KEY not found in .env file');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: ['application/sdp', 'text/plain'] }));

// Multer stores uploaded files in a temp directory
const upload = multer({ dest: os.tmpdir() });

// Serve converted slide images as static files
const SLIDES_DIR = path.join(os.tmpdir(), 'aipresenter-slides');
if (!fs.existsSync(SLIDES_DIR)) {
  fs.mkdirSync(SLIDES_DIR, { recursive: true });
}
app.use('/slides', express.static(SLIDES_DIR));

// ============================================================
// PPTX → Image Conversion (PowerPoint COM)
// ============================================================

app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const tempInput = req.file.path + '.pptx';
  fs.renameSync(req.file.path, tempInput);

  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const outputDir = path.join(SLIDES_DIR, sessionId);
  fs.mkdirSync(outputDir, { recursive: true });

  const scriptPath = path.join(__dirname, 'convert.ps1');

  console.log(`[convert] Starting: ${req.file.originalname}`);

  try {
    await new Promise((resolve, reject) => {
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -InputFile "${tempInput}" -OutputDir "${outputDir}"`;
      exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve(stdout.trim());
      });
    });

    const files = fs.readdirSync(outputDir)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/(\d+)/)?.[1] || '0');
        const numB = parseInt(b.match(/(\d+)/)?.[1] || '0');
        return numA - numB;
      });

    if (files.length === 0) throw new Error('No slide images generated. Is PowerPoint installed?');

    try { fs.unlinkSync(tempInput); } catch {}

    console.log(`[convert] OK: ${files.length} slides`);
    res.json({ success: true, slideCount: files.length, images: files.map(f => `/slides/${sessionId}/${f}`), sessionId });
  } catch (err) {
    try { fs.unlinkSync(tempInput); } catch {}
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
    console.error('[convert] Failed:', err.message);
    res.status(500).json({ error: 'Conversion failed. Is PowerPoint installed?', details: err.message });
  }
});

app.delete('/api/slides/:sessionId', (req, res) => {
  const dir = path.join(SLIDES_DIR, req.params.sessionId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// ============================================================
// OpenAI Whisper STT
// ============================================================

app.post('/api/whisper', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file' });
  }

  const t0 = Date.now();
  const tempPath = req.file.path;

  try {
    const buffer = fs.readFileSync(tempPath);
    const origName = req.file.originalname || 'recording.webm';
    console.log(`[whisper] Received: ${origName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'audio/webm' });
    formData.append('file', blob, 'recording.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });

    const data = await whisperResp.json();

    if (!whisperResp.ok) {
      console.error('[whisper] API error:', JSON.stringify(data));
      return res.status(whisperResp.status).json({ error: data.error?.message || 'Whisper API error' });
    }

    console.log(`[whisper] "${data.text}" (${Date.now() - t0}ms)`);
    res.json({ text: data.text });
  } catch (err) {
    console.error('[whisper] Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
});

// ============================================================
// OpenAI TTS
// ============================================================

app.post('/api/tts', async (req, res) => {
  const { text, voice = 'alloy', speed = 1 } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const t0 = Date.now();
  console.log(`[tts] Request: "${text.slice(0, 60)}..." (${text.length} chars)`);

  try {
    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice,
      input: text,
      speed,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`[tts] Done in ${Date.now() - t0}ms (${(buffer.length / 1024).toFixed(0)} KB)`);
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('[tts] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// OpenAI Chat Completions (GPT)
// ============================================================

app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  try {
    const completion = await openai.chat.completions.create(req.body);
    console.log(`[chat] Response in ${Date.now() - t0}ms`);
    res.json(completion);
  } catch (err) {
    console.error('[chat] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// OpenAI Realtime API — WebRTC session via unified interface
// ============================================================

app.post('/api/realtime/session', async (req, res) => {
  const t0 = Date.now();
  console.log('[realtime] Creating session...');

  try {
    // req.body is the raw SDP offer from the browser (text)
    const clientSdp = req.body;
    if (!clientSdp || typeof clientSdp !== 'string') {
      return res.status(400).json({ error: 'Missing SDP offer' });
    }

    // Use the simple WebRTC endpoint — just send raw SDP, model in query param.
    // gpt-4o-mini-realtime is 10x cheaper than gpt-4o-realtime ($0.03/min vs $0.30/min)
    // All session settings (voice, VAD, tools, etc.) go via data channel session.update.
    const response = await fetch(
      'https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/sdp',
        },
        body: clientSdp,
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[realtime] API error:', response.status, errText);
      return res.status(response.status).send(errText);
    }

    const answerSdp = await response.text();
    console.log(`[realtime] Session created in ${Date.now() - t0}ms`);
    res.type('application/sdp').send(answerSdp);
  } catch (err) {
    console.error('[realtime] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Health
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasApiKey: !!OPENAI_API_KEY });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  AI Presenter Server on http://localhost:${PORT}`);
  console.log(`  API key: ${OPENAI_API_KEY ? 'loaded' : 'MISSING'}`);
  console.log(`  Endpoints: /api/convert, /api/whisper, /api/tts, /api/chat\n`);
});
