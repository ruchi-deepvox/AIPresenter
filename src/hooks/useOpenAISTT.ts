import { useState, useCallback, useRef, useEffect } from 'react';

const SILENCE_DURATION = 1000;    // ms of silence after speech before sending (lowered for faster response)
const VOLUME_THRESHOLD = 8;       // avg frequency amplitude to detect speech
const MIN_RECORDING_MS = 500;     // minimum recording duration to be worth sending
const MAX_RECORDING_MS = 15000;   // safety net: force-send after 15s

/**
 * Well-known Whisper hallucination phrases.
 * Whisper generates these when given silent / ambient / music audio.
 */
const WHISPER_HALLUCINATIONS = [
  'thanks for watching',
  'thank you for watching',
  'thank you',
  'thanks for listening',
  'thank you for listening',
  'bye bye',
  'bye-bye',
  'goodbye',
  'see you next time',
  'see you in the next video',
  'see you in the next one',
  'please subscribe',
  'like and subscribe',
  'subscribe to the channel',
  'class dismissed',
  'yes please',
  'yes, please',
  'can you join me',
  'keep evolving',
  'you',
  '.',
  '. .',
  '...',
];

function isWhisperHallucination(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.!?,]+$/g, '').trim();
  if (t.length === 0) return true;
  if (t.length < 3) return true; // Single words / punctuation

  for (const h of WHISPER_HALLUCINATIONS) {
    if (t === h) return true;
  }

  // Repetitive patterns like "bye bye bye bye" or "thank you. thank you."
  const words = t.split(/\s+/);
  if (words.length >= 3) {
    const unique = new Set(words.map(w => w.replace(/[^a-z]/g, '')).filter(w => w.length > 0));
    if (unique.size <= 2) return true; // Only 1-2 unique words repeated
  }

  return false;
}

/**
 * Speech-to-text hook using OpenAI Whisper via the backend.
 *
 * Mic is muted during TTS (caller controls via mute/unmute).
 * Filters Whisper hallucinations before firing onResult.
 */
export function useOpenAISTT(onResult: (text: string) => void) {
  const [isActive, setIsActive] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isActiveRef = useRef(false);
  const isMutedRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const speechDetectedRef = useRef(false);
  const silenceStartRef = useRef(0);
  const recordingStartRef = useRef(0);
  const onResultRef = useRef(onResult);
  const startNewRecordingRef = useRef<() => void>(() => {});
  onResultRef.current = onResult;

  const getMimeType = useCallback(() => {
    if (typeof MediaRecorder === 'undefined') return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
    return 'audio/webm';
  }, []);

  const sendToWhisper = useCallback(async (blob: Blob) => {
    if (blob.size < 1000) {
      console.log('[STT] Audio too small, skipping:', blob.size, 'bytes');
      return;
    }
    console.log('[STT] Sending audio to Whisper:', (blob.size / 1024).toFixed(1), 'KB');
    try {
      const mimeType = blob.type || 'audio/webm';
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `recording.${ext}`);

      const resp = await fetch('/api/whisper', { method: 'POST', body: formData });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const text = data.text?.trim();
      console.log('[STT] Whisper result:', text || '(empty)');

      if (!text || text.length < 2) return;

      // Filter known Whisper hallucinations
      if (isWhisperHallucination(text)) {
        console.log('[STT] Filtered hallucination:', text);
        return;
      }

      setTranscript(text);
      setError(null);
      onResultRef.current(text);
    } catch (e) {
      console.error('[STT] Whisper error:', e);
      setError('Transcription failed');
    }
  }, []);

  const startNewRecording = useCallback(() => {
    if (!isActiveRef.current || isMutedRef.current || !streamRef.current) {
      return;
    }
    if (recorderRef.current?.state === 'recording') {
      return;
    }

    try {
      const mimeType = getMimeType();
      const recorder = new MediaRecorder(streamRef.current, { mimeType });
      chunksRef.current = [];
      speechDetectedRef.current = false;
      silenceStartRef.current = 0;
      recordingStartRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = chunksRef.current.length === 1
          ? chunksRef.current[0]
          : new Blob(chunksRef.current, { type: mimeType });
        const duration = Date.now() - recordingStartRef.current;

        if (speechDetectedRef.current && blob.size > 1000 && duration > MIN_RECORDING_MS) {
          console.log('[STT] Sending recording (duration:', duration, 'ms, size:', blob.size, ')');
          sendToWhisper(blob);
        } else {
          console.log('[STT] Discarding (speech:', speechDetectedRef.current, 'size:', blob.size, 'dur:', duration, ')');
        }

        // Restart if active and not muted
        if (isActiveRef.current && !isMutedRef.current) {
          setTimeout(() => startNewRecordingRef.current(), 100);
        } else {
          setIsListening(false);
        }
      };

      recorder.start();
      recorderRef.current = recorder;
      setIsListening(true);
      console.log('[STT] Recording started');
    } catch (e) {
      console.error('[STT] MediaRecorder error:', e);
      setError('Failed to start recording');
    }
  }, [getMimeType, sendToWhisper]);

  startNewRecordingRef.current = startNewRecording;

  // VAD loop
  const runVAD = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let logCounter = 0;

    const loop = () => {
      if (!isActiveRef.current) return;

      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      logCounter++;
      if (logCounter % 120 === 0) {
        console.log('[VAD] level:', avg.toFixed(1), '| muted:', isMutedRef.current, '| rec:', recorderRef.current?.state || 'none');
      }

      // Only process VAD when not muted and recording
      if (!isMutedRef.current && recorderRef.current?.state === 'recording') {
        const recordingDuration = Date.now() - recordingStartRef.current;

        if (avg > VOLUME_THRESHOLD) {
          if (!speechDetectedRef.current) {
            console.log('[VAD] Speech START (level:', avg.toFixed(1), ')');
          }
          speechDetectedRef.current = true;
          silenceStartRef.current = 0;
        } else if (speechDetectedRef.current) {
          if (silenceStartRef.current === 0) {
            silenceStartRef.current = Date.now();
          } else if (Date.now() - silenceStartRef.current > SILENCE_DURATION) {
            console.log('[VAD] Silence → stopping recorder');
            if (recorderRef.current?.state === 'recording') {
              recorderRef.current.stop();
            }
            rafRef.current = requestAnimationFrame(loop);
            return;
          }
        }

        if (speechDetectedRef.current && recordingDuration > MAX_RECORDING_MS) {
          console.log('[VAD] Max duration → stopping recorder');
          if (recorderRef.current?.state === 'recording') {
            recorderRef.current.stop();
          }
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const activate = useCallback(async () => {
    try {
      setError(null);
      console.log('[STT] Activating microphone...');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      console.log('[STT] Microphone access granted');

      const audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      isActiveRef.current = true;
      isMutedRef.current = false;
      setIsActive(true);

      startNewRecording();
      runVAD();
      console.log('[STT] Mic active, recording + VAD started');
    } catch (e) {
      console.error('[STT] Mic access error:', e);
      setError('Microphone access denied');
    }
  }, [startNewRecording, runVAD]);

  const deactivate = useCallback(() => {
    console.log('[STT] Deactivating');
    isActiveRef.current = false;
    isMutedRef.current = false;
    setIsActive(false);
    setIsListening(false);

    cancelAnimationFrame(rafRef.current);

    if (recorderRef.current?.state === 'recording') {
      try { recorderRef.current.stop(); } catch {}
    }
    recorderRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    if (audioCtxRef.current?.state !== 'closed') {
      audioCtxRef.current?.close().catch(() => {});
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, []);

  // Idempotent mute
  const mute = useCallback(() => {
    if (isMutedRef.current) return;
    console.log('[STT] Muting');
    isMutedRef.current = true;
    setIsListening(false);
    if (recorderRef.current?.state === 'recording') {
      speechDetectedRef.current = false; // discard current chunk
      try { recorderRef.current.stop(); } catch {}
    }
  }, []);

  // Idempotent unmute
  const unmute = useCallback(() => {
    if (!isMutedRef.current) return;
    console.log('[STT] Unmuting');
    isMutedRef.current = false;
    if (isActiveRef.current) {
      startNewRecordingRef.current();
    }
  }, []);

  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (recorderRef.current?.state === 'recording') {
        try { recorderRef.current.stop(); } catch {}
      }
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (audioCtxRef.current?.state !== 'closed') {
        audioCtxRef.current?.close().catch(() => {});
      }
    };
  }, []);

  return { activate, deactivate, mute, unmute, isActive, isListening, transcript, error };
}
