import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Text-to-speech hook using OpenAI TTS API via the backend.
 * - Sets isSpeaking=true IMMEDIATELY when speak() is called (before fetch)
 * - Cancels any in-flight TTS when a new speak() is called
 * - Properly cleans up audio on stop
 */
export function useOpenAITTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const onCompleteRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0); // guards against stale responses

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.removeAttribute('src');
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const speak = useCallback(async (text: string, onComplete?: () => void) => {
    if (!text || text.trim().length === 0) {
      onComplete?.();
      return;
    }

    // Cancel any previous in-flight TTS request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    cleanupAudio();
    onCompleteRef.current = null;

    // Increment generation so stale responses are ignored
    const gen = ++generationRef.current;

    // Set speaking IMMEDIATELY so mic mutes right away (before fetch)
    setIsSpeaking(true);
    setError(null);
    onCompleteRef.current = onComplete || null;

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      console.log('[TTS] Fetching audio for:', text.slice(0, 60) + '...');
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'alloy', speed: 1 }),
        signal: abortController.signal,
      });

      // If this request was superseded by a newer one, bail out
      if (gen !== generationRef.current) {
        console.log('[TTS] Stale response, ignoring');
        return;
      }

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `TTS failed: ${resp.status}`);
      }

      const blob = await resp.blob();

      // Check again after blob download
      if (gen !== generationRef.current) return;

      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        if (gen !== generationRef.current) return;
        console.log('[TTS] Audio playback ended');
        setIsSpeaking(false);
        cleanupAudio();
        const cb = onCompleteRef.current;
        onCompleteRef.current = null;
        cb?.();
      };

      audio.onerror = () => {
        if (gen !== generationRef.current) return;
        setIsSpeaking(false);
        setError('Audio playback failed');
        cleanupAudio();
        const cb = onCompleteRef.current;
        onCompleteRef.current = null;
        cb?.();
      };

      await audio.play();
      console.log('[TTS] Audio playing');
    } catch (e) {
      if (gen !== generationRef.current) return;
      if (e instanceof DOMException && e.name === 'AbortError') {
        // Aborted intentionally, don't set error
        return;
      }
      console.error('[TTS] Error:', e);
      setError(e instanceof Error ? e.message : 'TTS failed');
      setIsSpeaking(false);
      cleanupAudio();
      const cb = onCompleteRef.current;
      onCompleteRef.current = null;
      cb?.();
    }
  }, [cleanupAudio]);

  const stop = useCallback(() => {
    console.log('[TTS] Stopping');
    // Cancel in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Bump generation to invalidate any pending responses
    generationRef.current++;
    cleanupAudio();
    setIsSpeaking(false);
    setError(null);
    onCompleteRef.current = null;
    // Don't call onComplete when manually stopped
  }, [cleanupAudio]);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      cleanupAudio();
    };
  }, [cleanupAudio]);

  return { speak, stop, isSpeaking, error };
}
