import { useState, useCallback, useRef, useEffect } from 'react';
import { Slide } from '../types/slides';

/**
 * OpenAI Realtime API via WebRTC.
 * Single connection handles: speech input → AI reasoning → speech output.
 * ~500ms latency vs 5-8s with Whisper+GPT+TTS pipeline.
 *
 * Built-in server-side VAD handles echo cancellation and turn detection.
 */

interface NavigationAction {
  type: 'navigate';
  slideNumber: number;
}

interface UseRealtimeVoiceOptions {
  onNavigate?: (action: NavigationAction) => void;
  onTranscript?: (text: string, role: 'user' | 'assistant') => void;
  /** Called when AI starts/stops producing audio. Only fires for actual speech. */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Fired when server VAD detects the user started speaking */
  onUserSpeechStart?: () => void;
  /** Fired when the AI calls the resume_presentation tool (user said "continue") */
  onResume?: () => void;
}

export function useRealtimeVoice(options: UseRealtimeVoiceOptions = {}) {
  const [isConnected, setIsConnected] = useState(false);
  const [isSessionReady, setIsSessionReady] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const slidesRef = useRef<Slide[]>([]);
  const currentSlideRef = useRef(0);
  const isSpeakingRef = useRef(false);
  // Track pending function call results — we defer response.create until response.done
  const pendingFunctionResultRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Update slide context (called by App when slides/currentSlide change)
  const updateContext = useCallback((slides: Slide[], currentSlide: number) => {
    slidesRef.current = slides;
    currentSlideRef.current = currentSlide;
  }, []);

  // Send an event over the data channel
  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(event));
    }
  }, []);

  // Update the session instructions with current slide context
  // Also includes voice/VAD/transcription config (combined into one session.update)
  const updateInstructions = useCallback((slides: Slide[], currentSlide: number) => {
    const slideList = slides
      .map((s, i) => {
        if (i === currentSlide) {
          return `  Slide ${i + 1} [CURRENT]: "${s.title}"${s.content ? ` — ${s.content}` : ''}`;
        }
        return `  Slide ${i + 1}: "${s.title}"`;
      })
      .join('\n');

    const instructions = `You are a professional AI presentation assistant. You present slides naturally, like a real human presenter.

SLIDES:
${slideList}

You are currently on slide ${currentSlide + 1} of ${slides.length}.

MODE — NARRATION (when you receive a system narration prompt):
- Explain the slide content naturally and concisely.
- Do NOT ask the viewer any questions. Do NOT say "does that answer your question" or "do you have any questions".
- Just narrate the content and stop. The system will advance to the next slide automatically.

MODE — Q&A (when the viewer speaks to you via microphone):
- Answer their question clearly and concisely (1-3 sentences).
- If the question is about a different slide, call navigate_to_slide to go there, then explain.
- After answering, ask: "Does that answer your question? Should I continue with the presentation?"
- If the viewer says "yes", "continue", "go on", etc. → call resume_presentation.
- If the viewer asks a follow-up → answer it, then ask again if they're satisfied.

TOOLS:
- navigate_to_slide: Navigate to a specific slide number.
- resume_presentation: Return to where you were before the interruption and continue presenting.`;

    sendEvent({
      type: 'session.update',
      session: {
        voice: 'alloy',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        instructions,
        tools: [
          {
            type: 'function',
            name: 'navigate_to_slide',
            description: 'Navigate to a specific slide. Use when user asks about a topic on a different slide.',
            parameters: {
              type: 'object',
              properties: {
                slide_number: {
                  type: 'integer',
                  description: 'Slide number (1-indexed)',
                },
              },
              required: ['slide_number'],
            },
          },
          {
            type: 'function',
            name: 'resume_presentation',
            description: 'Resume the presentation from where it was before the user interrupted. Call when the user says "continue", "go on", "yes", or indicates they are satisfied.',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        ],
      },
    });
  }, [sendEvent]);

  // Handle incoming events from the Realtime API
  const handleServerEvent = useCallback((event: Record<string, unknown>) => {
    const type = event.type as string;

    switch (type) {
      case 'session.created':
        console.log('[Realtime] Session created — configuring...');
        setIsConnected(true);
        // Send combined config (voice + VAD + instructions + tools) in one event
        updateInstructions(slidesRef.current, currentSlideRef.current);
        break;

      case 'session.updated':
        console.log('[Realtime] Session configured and ready');
        // Session is fully configured now — safe to start narrating
        setIsSessionReady(true);
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[Realtime] Speech detected, AI speaking:', isSpeakingRef.current);
        setIsListening(true);
        // Only treat as a real user interruption if the AI is NOT currently speaking.
        // When AI is speaking, the mic picks up its audio output (echo) which the
        // server VAD falsely detects as user speech. Real interruptions during AI
        // speech should use the Space key.
        if (!isSpeakingRef.current) {
          optionsRef.current.onUserSpeechStart?.();
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[Realtime] User stopped speaking');
        setIsListening(false);
        break;

      case 'response.audio.delta':
        // AI is producing audio output — use ref to avoid stale closure
        if (!isSpeakingRef.current) {
          isSpeakingRef.current = true;
          setIsSpeaking(true);
          optionsRef.current.onSpeakingChange?.(true);
        }
        break;

      case 'response.audio.done':
        console.log('[Realtime] AI audio stream done');
        break;

      case 'response.done': {
        console.log('[Realtime] Response complete');

        // CRITICAL: Only fire onSpeakingChange(false) if the AI was actually speaking audio.
        // response.done fires for ALL responses including function-call-only responses
        // and text-only responses. We must NOT trigger advance for those.
        if (isSpeakingRef.current) {
          isSpeakingRef.current = false;
          setIsSpeaking(false);
          optionsRef.current.onSpeakingChange?.(false);
        }

        // If a function call result was queued, now it's safe to request a follow-up response
        if (pendingFunctionResultRef.current) {
          pendingFunctionResultRef.current = false;
          sendEvent({ type: 'response.create' });
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = (event as any).transcript?.trim();
        if (transcript) {
          console.log('[Realtime] User said:', transcript);
          optionsRef.current.onTranscript?.(transcript, 'user');
        }
        break;
      }

      case 'response.audio_transcript.done': {
        const transcript = (event as any).transcript?.trim();
        if (transcript) {
          console.log('[Realtime] AI said:', transcript);
          optionsRef.current.onTranscript?.(transcript, 'assistant');
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const name = (event as any).name;
        const callId = (event as any).call_id;
        const args = JSON.parse((event as any).arguments || '{}');
        console.log('[Realtime] Function call:', name, args);

        if (name === 'navigate_to_slide' && args.slide_number) {
          const slideNum = parseInt(args.slide_number, 10);
          const slides = slidesRef.current;

          if (slideNum >= 1 && slideNum <= slides.length) {
            optionsRef.current.onNavigate?.({ type: 'navigate', slideNumber: slideNum });
            sendEvent({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ success: true, navigated_to: slideNum }),
              },
            });
          } else {
            sendEvent({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ success: false, error: 'Invalid slide number' }),
              },
            });
          }

          // Don't send response.create here — wait for response.done first
          // to avoid "Conversation already has an active response in progress"
          pendingFunctionResultRef.current = true;

        } else if (name === 'resume_presentation') {
          console.log('[Realtime] Resuming presentation');
          optionsRef.current.onResume?.();

          sendEvent({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ success: true, resumed: true }),
            },
          });

          // Defer response.create until response.done
          pendingFunctionResultRef.current = true;
        }
        break;
      }

      case 'error': {
        const errMsg = (event as any).error?.message || 'Realtime API error';
        console.error('[Realtime] Error:', errMsg);
        setError(errMsg);
        break;
      }

      default:
        // Log unknown events at debug level
        if (type && !type.startsWith('response.audio.delta') && !type.startsWith('response.audio_transcript.delta')) {
          // console.log('[Realtime] Event:', type);
        }
        break;
    }
  }, [updateInstructions, sendEvent]);

  // Keep a ref to the latest handleServerEvent so the data channel always calls the current version
  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  // Connect to the Realtime API
  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsSessionReady(false);
      console.log('[Realtime] Connecting...');

      // Create peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Set up remote audio playback
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioElRef.current = audioEl;

      pc.ontrack = (e) => {
        console.log('[Realtime] Got remote audio track');
        audioEl.srcObject = e.streams[0];
      };

      // Add local mic audio
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      pc.addTrack(stream.getTracks()[0]);
      console.log('[Realtime] Mic connected');

      // Create data channel for events
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.addEventListener('open', () => {
        console.log('[Realtime] Data channel open');
      });

      dc.addEventListener('message', (e) => {
        try {
          const event = JSON.parse(e.data);
          handleServerEventRef.current(event);
        } catch {
          // ignore parse errors
        }
      });

      // Create SDP offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Exchange SDP with our backend (which proxies to OpenAI)
      console.log('[Realtime] Exchanging SDP...');
      const sdpResponse = await fetch('/api/realtime/session', {
        method: 'POST',
        body: offer.sdp,
        headers: { 'Content-Type': 'application/sdp' },
      });

      if (!sdpResponse.ok) {
        const errText = await sdpResponse.text();
        throw new Error(`Session failed: ${sdpResponse.status} ${errText}`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      console.log('[Realtime] WebRTC connected!');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      console.error('[Realtime] Connection error:', msg);
      setError(msg);
      setIsConnected(false);
      setIsSessionReady(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    console.log('[Realtime] Disconnecting');

    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }

    setIsConnected(false);
    setIsSessionReady(false);
    setIsSpeaking(false);
    setIsListening(false);
  }, []);

  // Ask AI to narrate (auto-advance mode). Cancels any in-progress response first.
  const speakText = useCallback((text: string) => {
    // Cancel any in-progress response to avoid "already active" error
    sendEvent({ type: 'response.cancel' });
    pendingFunctionResultRef.current = false;

    sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    sendEvent({ type: 'response.create' });
  }, [sendEvent]);

  // Interrupt AI speech (cancel current response)
  const interrupt = useCallback(() => {
    sendEvent({ type: 'response.cancel' });
    pendingFunctionResultRef.current = false;
    isSpeakingRef.current = false;
    setIsSpeaking(false);
    optionsRef.current.onSpeakingChange?.(false);
  }, [sendEvent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (dcRef.current) dcRef.current.close();
      if (pcRef.current) pcRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  return {
    connect,
    disconnect,
    updateContext,
    updateInstructions,
    speakText,
    interrupt,
    sendEvent,
    isConnected,
    isSessionReady,
    isSpeaking,
    isListening,
    error,
  };
}
