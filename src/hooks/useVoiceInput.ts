import { useState, useCallback, useRef, useEffect } from 'react';

const SpeechRecognition =
  typeof window !== 'undefined'
    ? (window as unknown as { SpeechRecognition?: new () => SpeechRecognition; webkitSpeechRecognition?: new () => SpeechRecognition })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition ||
      null
    : null;

/**
 * Always-on voice input hook.
 * Once activated, recognition runs continuously and auto-restarts if the browser stops it.
 * Results are delivered via `onResult` callback whenever a final transcript is available.
 */
export const useVoiceInput = (onResult: (text: string) => void) => {
  const [isActive, setIsActive] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<InstanceType<NonNullable<typeof SpeechRecognition>> | null>(null);
  const onResultRef = useRef(onResult);
  const isActiveRef = useRef(false);
  const isMutedRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  onResultRef.current = onResult;

  const createRecognition = useCallback(() => {
    if (!SpeechRecognition) return null;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const results = event.results;
      let interim = '';
      for (let i = event.resultIndex; i < results.length; i++) {
        const result = results[i];
        if (result.isFinal) {
          const text = result[0]?.transcript?.trim();
          if (text && text.length > 1) {
            setTranscript(text);
            onResultRef.current(text);
          }
        } else {
          interim += result[0]?.transcript || '';
        }
      }
      if (interim) setTranscript(interim);
    };

    recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'no-speech') return; // normal - just no speech detected
      if (e.error === 'aborted') return;   // we aborted it intentionally
      if (e.error === 'not-allowed') {
        setError('Microphone permission denied. Please allow microphone access.');
        setIsActive(false);
        isActiveRef.current = false;
        return;
      }
      // For other errors, just log - will auto-restart
      console.warn('Speech recognition error:', e.error);
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;

      // Auto-restart if still active and not muted
      if (isActiveRef.current && !isMutedRef.current) {
        restartTimerRef.current = setTimeout(() => {
          if (isActiveRef.current && !isMutedRef.current) {
            try {
              const newRecognition = createRecognition();
              if (newRecognition) {
                recognitionRef.current = newRecognition;
                newRecognition.start();
              }
            } catch {
              // Will retry on next cycle
              restartTimerRef.current = setTimeout(() => {
                if (isActiveRef.current) {
                  const r = createRecognition();
                  if (r) {
                    recognitionRef.current = r;
                    try { r.start(); } catch { /* ignore */ }
                  }
                }
              }, 1000);
            }
          }
        }, 300);
      }
    };

    return recognition;
  }, []);

  const activate = useCallback(() => {
    if (!SpeechRecognition) {
      setError('Speech recognition not supported. Please use Chrome.');
      return;
    }

    setError(null);
    setIsActive(true);
    isActiveRef.current = true;

    // Stop any existing
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }

    try {
      const recognition = createRecognition();
      if (recognition) {
        recognitionRef.current = recognition;
        recognition.start();
      }
    } catch (err) {
      console.error('Failed to start recognition:', err);
      setError('Failed to start microphone');
    }
  }, [createRecognition]);

  // Mute: stop recognition but keep active so it auto-resumes on unmute
  const mute = useCallback(() => {
    isMutedRef.current = true;
    setIsListening(false);

    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
  }, []);

  // Unmute: restart recognition
  const unmute = useCallback(() => {
    isMutedRef.current = false;

    if (!isActiveRef.current || !SpeechRecognition) return;

    // Small delay to let TTS audio fully stop
    restartTimerRef.current = setTimeout(() => {
      if (isActiveRef.current && !isMutedRef.current) {
        try {
          const recognition = createRecognition();
          if (recognition) {
            recognitionRef.current = recognition;
            recognition.start();
          }
        } catch {
          /* will retry via onend */
        }
      }
    }, 400);
  }, [createRecognition]);

  const deactivate = useCallback(() => {
    isActiveRef.current = false;
    setIsActive(false);
    setIsListening(false);

    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }

    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* ignore */ }
      }
    };
  }, []);

  return {
    activate,
    deactivate,
    mute,
    unmute,
    isActive,
    isListening,
    transcript,
    error,
    isSupported: !!SpeechRecognition,
  };
};
