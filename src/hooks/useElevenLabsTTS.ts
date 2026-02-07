import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * ElevenLabs streaming TTS.
 *
 * Sends text to backend proxy → receives streaming MP3 audio → plays via AudioContext.
 * Knows EXACTLY when audio finishes playing (no estimation needed).
 *
 * Supports interruption: stop() clears all queued audio and halts playback immediately.
 */

interface UseElevenLabsTTSOptions {
  /** Called when speaking state changes (true = started, false = finished) */
  onSpeakingChange?: (speaking: boolean) => void;
}

export function useElevenLabsTTS(options: UseElevenLabsTTSOptions = {}) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const isSpeakingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Queue of audio buffers waiting to play (for chunked streaming)
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  // Track when we're fetching/decoding (even before first audio plays)
  const isFetchingRef = useRef(false);
  // Fallback timeout when onended doesn't fire (e.g. AudioContext suspended by browser)
  const fallbackDoneRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getAudioContext = useCallback(async (): Promise<AudioContext> => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContext();
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const setSpeakingState = useCallback((speaking: boolean) => {
    if (isSpeakingRef.current !== speaking) {
      isSpeakingRef.current = speaking;
      setIsSpeaking(speaking);
      optionsRef.current.onSpeakingChange?.(speaking);
    }
  }, []);

  const clearFallbackDone = useCallback(() => {
    if (fallbackDoneRef.current) {
      clearTimeout(fallbackDoneRef.current);
      fallbackDoneRef.current = null;
    }
  }, []);

  // Play the next buffer in the queue
  const playNext = useCallback(() => {
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === 'closed') return;

    const buffer = audioQueueRef.current.shift();
    if (!buffer) {
      // Queue empty — if we're done fetching, audio is complete
      isPlayingRef.current = false;
      clearFallbackDone();
      if (!isFetchingRef.current) {
        console.log('[ElevenLabsTTS] Playback complete');
        setSpeakingState(false);
      }
      return;
    }

    isPlayingRef.current = true;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    currentSourceRef.current = source;

    source.onended = () => {
      currentSourceRef.current = null;
      // Play next chunk
      playNext();
    };

    source.start();
  }, [setSpeakingState, clearFallbackDone]);

  // Enqueue a decoded audio buffer for playback
  const enqueueAudio = useCallback((buffer: AudioBuffer) => {
    clearFallbackDone();
    audioQueueRef.current.push(buffer);

    // Mark as speaking as soon as first audio is enqueued
    if (!isSpeakingRef.current) {
      setSpeakingState(true);
    }

    // Fallback: if onended doesn't fire (e.g. AudioContext suspended by browser), signal done after duration
    const durationMs = (buffer.duration + 0.5) * 1000;
    fallbackDoneRef.current = setTimeout(() => {
      fallbackDoneRef.current = null;
      if (isSpeakingRef.current) {
        console.log('[ElevenLabsTTS] Playback complete (fallback)');
        setSpeakingState(false);
      }
    }, durationMs);

    // If not currently playing, start
    if (!isPlayingRef.current) {
      playNext();
    }
  }, [setSpeakingState, playNext, clearFallbackDone]);

  // Stop all playback immediately (must be defined before speak, which uses it)
  const stopPlayback = useCallback(() => {
    clearFallbackDone();
    // Abort any in-flight fetch
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    // Stop current audio source
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.onended = null;
        currentSourceRef.current.stop();
      } catch {}
      currentSourceRef.current = null;
    }

    // Clear queue
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    isFetchingRef.current = false;
  }, [clearFallbackDone]);

  /**
   * Speak the given text via ElevenLabs TTS.
   * Fetches full audio then decodes — decodeAudioData cannot handle partial MP3.
   */
  const speak = useCallback(async (text: string): Promise<void> => {
    stopPlayback();

    setError(null);
    isFetchingRef.current = true;
    console.log('[ElevenLabsTTS] Speaking:', text.slice(0, 60) + '...');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch('/api/elevenlabs/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(errData.error || `TTS failed: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      if (abortController.signal.aborted) return;

      const ctx = await getAudioContext();
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      enqueueAudio(buffer);

      isFetchingRef.current = false;

      if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
        setSpeakingState(false);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        console.log('[ElevenLabsTTS] Fetch aborted (interrupted)');
      } else {
        const msg = err instanceof Error ? err.message : 'TTS failed';
        console.error('[ElevenLabsTTS] Error:', msg);
        setError(msg);
      }
      isFetchingRef.current = false;
      setSpeakingState(false);
    }
  }, [getAudioContext, enqueueAudio, setSpeakingState, stopPlayback]);

  /** Stop speaking and clear everything */
  const stop = useCallback(() => {
    stopPlayback();
    setSpeakingState(false);
    console.log('[ElevenLabsTTS] Stopped');
  }, [stopPlayback, setSpeakingState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearFallbackDone();
      stopPlayback();
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    speak,
    stop,
    isSpeaking,
    error,
  };
}
