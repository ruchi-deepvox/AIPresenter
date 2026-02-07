import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Deepgram streaming STT via WebSocket proxy.
 *
 * Audio path: Mic → AudioWorklet (PCM16) → WebSocket → Backend → Deepgram
 * Transcript path: Deepgram → Backend → WebSocket → this hook → callbacks
 *
 * Always-on mic: the WebSocket stays open and audio streams continuously.
 * Browser AEC (echoCancellation: true) filters out speaker playback from the mic.
 */

interface UseDeepgramSTTOptions {
  /** Called with each transcript update. isFinal=true means the phrase is done. */
  onTranscript?: (text: string, isFinal: boolean) => void;
  /** Called when the user finishes an utterance (silence detected). Contains full text. */
  onUtteranceEnd?: (fullText: string) => void;
  /** Called when Deepgram detects speech started */
  onSpeechStart?: () => void;
}

export function useDeepgramSTT(options: UseDeepgramSTTOptions = {}) {
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Accumulate final transcripts until utterance_end
  const accumulatedTextRef = useRef('');
  // Track if we're currently hearing speech
  const isSpeechActiveRef = useRef(false);

  const connect = useCallback(async () => {
    try {
      setError(null);
      console.log('[DeepgramSTT] Connecting...');

      // 1. Get microphone with echo cancellation
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      // 2. Set up AudioContext to capture PCM16 data
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      contextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);

      // ScriptProcessorNode to get raw audio buffers
      // (AudioWorklet would be better but ScriptProcessor is simpler and widely supported)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // 3. Connect to backend WebSocket proxy
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/deepgram/listen`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log('[DeepgramSTT] WebSocket open');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleDeepgramMessage(msg);
        } catch {
          // Binary or unparseable — ignore
        }
      };

      ws.onerror = (e) => {
        console.error('[DeepgramSTT] WebSocket error:', e);
        setError('Deepgram connection error');
      };

      ws.onclose = () => {
        console.log('[DeepgramSTT] WebSocket closed');
        setIsConnected(false);
        setIsListening(false);
      };

      // 4. When audio data is available, convert to PCM16 and send
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        ws.send(int16.buffer);
      };

      source.connect(processor);
      processor.connect(audioCtx.destination); // Required for ScriptProcessor to fire

      setIsConnected(true);
      setIsListening(true);
      console.log('[DeepgramSTT] Connected and listening');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to connect';
      console.error('[DeepgramSTT] Error:', msg);
      setError(msg);
    }
  }, []);

  const handleDeepgramMessage = useCallback((msg: any) => {
    const type = msg.type;

    if (type === 'connected') {
      console.log('[DeepgramSTT] Deepgram proxy connected');
      return;
    }

    if (type === 'error') {
      console.error('[DeepgramSTT] Error from server:', msg.message);
      setError(msg.message);
      return;
    }

    // Deepgram speech started event
    if (type === 'SpeechStarted') {
      if (!isSpeechActiveRef.current) {
        isSpeechActiveRef.current = true;
        console.log('[DeepgramSTT] Speech started');
        optionsRef.current.onSpeechStart?.();
      }
      return;
    }

    // Deepgram transcript result
    if (type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;

      const transcript = alt.transcript?.trim();
      if (!transcript) return;

      const isFinal = msg.is_final === true;
      const speechFinal = msg.speech_final === true;

      if (isFinal) {
        // Accumulate final transcripts
        accumulatedTextRef.current += (accumulatedTextRef.current ? ' ' : '') + transcript;
        console.log('[DeepgramSTT] Final:', transcript);
      }

      optionsRef.current.onTranscript?.(
        isFinal ? accumulatedTextRef.current : (accumulatedTextRef.current + ' ' + transcript).trim(),
        isFinal
      );

      // speech_final means Deepgram detected end of speech turn
      if (speechFinal && accumulatedTextRef.current) {
        const fullText = accumulatedTextRef.current;
        console.log('[DeepgramSTT] Speech final:', fullText);
        accumulatedTextRef.current = '';
        isSpeechActiveRef.current = false;
        optionsRef.current.onUtteranceEnd?.(fullText);
      }
      return;
    }

    // Deepgram utterance_end event — silence detected after speech
    if (type === 'UtteranceEnd') {
      if (accumulatedTextRef.current) {
        const fullText = accumulatedTextRef.current;
        console.log('[DeepgramSTT] Utterance end:', fullText);
        accumulatedTextRef.current = '';
        isSpeechActiveRef.current = false;
        optionsRef.current.onUtteranceEnd?.(fullText);
      }
      return;
    }
  }, []);

  const disconnect = useCallback(() => {
    console.log('[DeepgramSTT] Disconnecting...');

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (contextRef.current) {
      contextRef.current.close().catch(() => {});
      contextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'close' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }

    accumulatedTextRef.current = '';
    isSpeechActiveRef.current = false;
    setIsConnected(false);
    setIsListening(false);
  }, []);

  // Reset accumulated text (e.g., when AI starts speaking and we want to ignore echo)
  const resetTranscript = useCallback(() => {
    accumulatedTextRef.current = '';
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      if (contextRef.current) {
        contextRef.current.close().catch(() => {});
      }
    };
  }, []);

  return {
    connect,
    disconnect,
    resetTranscript,
    isConnected,
    isListening,
    error,
  };
}
