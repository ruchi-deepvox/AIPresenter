import { useState, useCallback, useRef, useEffect } from 'react';

export const useSpeechSynthesis = () => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const speak = useCallback((text: string, onComplete?: () => void) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      setError('Speech synthesis not supported');
      onComplete?.();
      return;
    }

    try {
      setError(null);
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume?.();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.lang = 'en-US';
      utteranceRef.current = utterance;

      utterance.onend = () => {
        setIsSpeaking(false);
        utteranceRef.current = null;
        onComplete?.();
      };

      utterance.onerror = (e: Event & { error?: string }) => {
        setIsSpeaking(false);
        const err = (e as SpeechSynthesisErrorEvent).error ?? (e as Event & { error?: string }).error;
        if (err !== 'canceled' && err !== 'interrupted') {
          setError('Speech failed');
        }
        utteranceRef.current = null;
        onComplete?.();
      };

      window.speechSynthesis.speak(utterance);
      setIsSpeaking(true);
    } catch (err) {
      setError('Speech failed');
      setIsSpeaking(false);
      onComplete?.();
    }
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    utteranceRef.current = null;
    setIsSpeaking(false);
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return { speak, stop, isSpeaking, error };
};
