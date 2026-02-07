import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// API Keys
// ============================================================

const OPENAI_API_KEY = process.env.VITE_OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

if (!OPENAI_API_KEY) console.warn('[server] WARNING: VITE_OPENAI_API_KEY not found');
if (!DEEPGRAM_API_KEY) console.warn('[server] WARNING: DEEPGRAM_API_KEY not found');
if (!ELEVENLABS_API_KEY) console.warn('[server] WARNING: ELEVENLABS_API_KEY not found');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ============================================================
// Express + HTTP server (needed for WebSocket upgrade)
// ============================================================

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({ dest: os.tmpdir() });

// Serve converted slide images
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
// ElevenLabs Streaming TTS Proxy
// ============================================================

const ELEVENLABS_DEFAULT_VOICE = '0p0kYzKW1Gq5uoKh8Qod';

app.post('/api/elevenlabs/tts', async (req, res) => {
  const { text, voice_id } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'No text provided' });
  }
  if (!ELEVENLABS_API_KEY || ELEVENLABS_API_KEY === 'YOUR_ELEVENLABS_API_KEY_HERE') {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
  }

  const voiceId = voice_id || ELEVENLABS_DEFAULT_VOICE;
  const t0 = Date.now();
  console.log(`[elevenlabs] TTS request: "${text.slice(0, 60)}..." (${text.length} chars, voice: ${voiceId})`);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[elevenlabs] API error:', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    // Stream audio back to the client
    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });

    const reader = response.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      res.write(Buffer.from(value));
    }

    res.end();
    console.log(`[elevenlabs] TTS done in ${Date.now() - t0}ms (${(totalBytes / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.error('[elevenlabs] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

// ============================================================
// Deepgram WebSocket Proxy
// ============================================================

const wss = new WebSocketServer({ noServer: true });

// Handle HTTP upgrade for WebSocket connections
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/api/deepgram/listen') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (clientWs) => {
  console.log('[deepgram] Browser connected via WebSocket');

  if (!DEEPGRAM_API_KEY || DEEPGRAM_API_KEY === 'YOUR_DEEPGRAM_API_KEY_HERE') {
    clientWs.send(JSON.stringify({ type: 'error', message: 'DEEPGRAM_API_KEY not configured' }));
    clientWs.close();
    return;
  }

  // Open WebSocket to Deepgram
  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model: 'nova-2',
    punctuate: 'true',
    interim_results: 'true',
    utterance_end_ms: '1500',
    smart_format: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing: '300',
    vad_events: 'true',
  }).toString();

  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  let dgReady = false;

  dgWs.on('open', () => {
    dgReady = true;
    console.log('[deepgram] Connected to Deepgram');
    clientWs.send(JSON.stringify({ type: 'connected' }));
  });

  dgWs.on('message', (data) => {
    // Forward Deepgram transcript events to the browser
    try {
      const msg = JSON.parse(data.toString());
      clientWs.send(JSON.stringify(msg));
    } catch {
      // Binary data — ignore
    }
  });

  dgWs.on('error', (err) => {
    console.error('[deepgram] WebSocket error:', err.message);
    clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
  });

  dgWs.on('close', (code, reason) => {
    console.log(`[deepgram] Deepgram WS closed: ${code} ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'deepgram_closed' }));
      clientWs.close();
    }
  });

  // Forward audio from browser to Deepgram
  clientWs.on('message', (data, isBinary) => {
    if (isBinary && dgReady && dgWs.readyState === WebSocket.OPEN) {
      dgWs.send(data);
    } else if (!isBinary) {
      // Handle text commands from client
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.type === 'close') {
          // Gracefully close Deepgram connection
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: 'CloseStream' }));
          }
        }
      } catch {}
    }
  });

  clientWs.on('close', () => {
    console.log('[deepgram] Browser disconnected');
    if (dgWs.readyState === WebSocket.OPEN) {
      dgWs.send(JSON.stringify({ type: 'CloseStream' }));
      dgWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error('[deepgram] Client WS error:', err.message);
  });
});

// ============================================================
// Health
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    keys: {
      openai: !!OPENAI_API_KEY,
      deepgram: !!(DEEPGRAM_API_KEY && DEEPGRAM_API_KEY !== 'YOUR_DEEPGRAM_API_KEY_HERE'),
      elevenlabs: !!(ELEVENLABS_API_KEY && ELEVENLABS_API_KEY !== 'YOUR_ELEVENLABS_API_KEY_HERE'),
    },
  });
});

// ============================================================
// Start (use server.listen instead of app.listen for WS support)
// ============================================================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  AI Presenter Server on http://localhost:${PORT}`);
  console.log(`  OpenAI:     ${OPENAI_API_KEY ? 'loaded' : 'MISSING'}`);
  console.log(`  Deepgram:   ${DEEPGRAM_API_KEY && DEEPGRAM_API_KEY !== 'YOUR_DEEPGRAM_API_KEY_HERE' ? 'loaded' : 'MISSING'}`);
  console.log(`  ElevenLabs: ${ELEVENLABS_API_KEY && ELEVENLABS_API_KEY !== 'YOUR_ELEVENLABS_API_KEY_HERE' ? 'loaded' : 'MISSING'}`);
  console.log(`  Endpoints: /api/convert, /api/chat, /api/elevenlabs/tts, /api/deepgram/listen (WS)\n`);
});
