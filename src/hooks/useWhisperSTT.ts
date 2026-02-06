import { useState, useCallback, useRef } from 'react';

const SILENCE_MS = 1200;
const CHECK_INTERVAL_MS = 100;
const VOLUME_THRESHOLD = 0.015;
const MIN_BLOB_BYTES = 500;

function getSupportedMimeType(): string {
  const types = ['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export const useWhisperSTT = (onResult: (text: string) => void) => {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const stopRecording = useCallback(() => {
    vadIntervalRef.current && clearInterval(vadIntervalRef.current);
    vadIntervalRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
  }, []);

  const startListening = useCallback(async () => {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      setError('API key not found');
      return;
    }

    try {
      setError(null);
      chunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType, audioBitsPerSecond: 128000 } : { audioBitsPerSecond: 128000 };
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
        chunksRef.current = [];

        const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';

        if (blob.size < MIN_BLOB_BYTES) {
          setIsListening(false);
          return;
        }

        try {
          const formData = new FormData();
          formData.append('file', blob, `recording.${ext}`);
          formData.append('model', 'whisper-1');
          formData.append('language', 'en');

          const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: formData,
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `Transcription failed: ${response.status}`);
          }

          const data = (await response.json()) as { text?: string };
          const text = data.text?.trim();
          if (text) {
            onResultRef.current(text);
          }
        } catch (err) {
          console.error('Whisper error:', err);
          setError(err instanceof Error ? err.message : 'Transcription failed');
        } finally {
          setIsListening(false);
        }
      };

      mediaRecorder.start(200);
      setIsListening(true);

      const audioContext = new AudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);
      let lastSpeechTime = 0;
      let hadSpeech = false;

      vadIntervalRef.current = setInterval(() => {
        if (mediaRecorderRef.current?.state !== 'recording') return;
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);

        if (rms > VOLUME_THRESHOLD) {
          lastSpeechTime = Date.now();
          hadSpeech = true;
        }

        if (hadSpeech && Date.now() - lastSpeechTime > SILENCE_MS) {
          stopRecording();
        }
      }, CHECK_INTERVAL_MS);

      setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          stopRecording();
        }
      }, 20000);
    } catch (err) {
      console.error('Failed to start recording:', err);
      setError(err instanceof Error ? err.message : 'Microphone access denied');
    }
  }, [stopRecording]);

  const stopListening = useCallback(() => {
    stopRecording();
    setIsListening(false);
  }, [stopRecording]);

  return { startListening, stopListening, isListening, error, isSupported: true };
};
