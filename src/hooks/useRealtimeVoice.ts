import { useState, useCallback, useRef, useEffect } from 'react';
import { Slide } from '../types/slides';

/**
 * OpenAI Realtime API via WebRTC.
 *
 * Key design decisions:
 *  - turn_detection.create_response = false  → echo won't auto-create responses
 *  - turn_detection.interrupt_response = false → echo won't interrupt narration
 *  - We manually send response.create when user genuinely speaks (between slides)
 *  - Mic stays active at all times (no muting)
 *
 * WebRTC audio timing:
 *  - Audio streams via the media track (not data channel events)
 *  - response.done fires when GENERATION completes, NOT when PLAYBACK finishes
 *  - We estimate playback duration from transcript length to sync slide advances
 */

interface NavigationAction {
  type: 'navigate';
  slideNumber: number;
}

interface UseRealtimeVoiceOptions {
  onNavigate?: (action: NavigationAction) => void;
  onTranscript?: (text: string, role: 'user' | 'assistant') => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onUserSpeechStart?: () => void;
  onResume?: () => void;
}

// Estimated characters-per-second for OpenAI "alloy" voice (~150 wpm)
const CHARS_PER_SECOND = 14;

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
  const pendingFunctionResultRef = useRef(false);
  // Time when last AI audio playback actually finished (estimated)
  const lastResponseDoneTimeRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // --- Audio duration estimation refs ---
  // When the first transcript delta arrives (= audio starts playing)
  const speakingStartTimeRef = useRef(0);
  // Accumulated transcript text — used to estimate total audio duration
  const accumulatedTranscriptRef = useRef('');
  // Timeout that fires when we estimate audio playback has finished
  const audioFinishTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when user deliberately interrupted via voice — ensures response.create fires on speech_stopped
  const userInterruptedRef = useRef(false);

  const clearAudioFinishTimeout = useCallback(() => {
    if (audioFinishTimeoutRef.current) {
      clearTimeout(audioFinishTimeoutRef.current);
      audioFinishTimeoutRef.current = null;
    }
  }, []);

  const updateContext = useCallback((slides: Slide[], currentSlide: number) => {
    slidesRef.current = slides;
    currentSlideRef.current = currentSlide;
  }, []);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(event));
    }
  }, []);

  // Helper: mark AI as done speaking (called after estimated playback finishes)
  const finishSpeaking = useCallback(() => {
    isSpeakingRef.current = false;
    lastResponseDoneTimeRef.current = Date.now();
    accumulatedTranscriptRef.current = '';
    setIsSpeaking(false);
    optionsRef.current.onSpeakingChange?.(false);
    console.log('[Realtime] AI finished speaking (estimated playback done)');
  }, []);

  // Update session: voice, VAD, instructions, tools — all in one event
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

MODE — NARRATION (when you receive a [NARRATION] prompt):
- Explain the slide content naturally and concisely.
- Do NOT ask the viewer any questions. Do NOT say "does that answer your question".
- Just narrate the content and stop. The system will advance to the next slide automatically.

MODE — Q&A (when the viewer speaks to you via microphone):
- Answer their question clearly and concisely (1-3 sentences).
- If the question is about a different slide, call navigate_to_slide to go there, then explain.
- After answering, ask: "Does that answer your question? Should I continue with the presentation?"
- If the viewer says "yes", "continue", "go on", etc. → call resume_presentation.
- If the viewer asks a follow-up → answer it, then ask again if satisfied.`;

    sendEvent({
      type: 'session.update',
      session: {
        voice: 'alloy',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: false,
          interrupt_response: false,
        },
        instructions,
        tools: [
          {
            type: 'function',
            name: 'navigate_to_slide',
            description: 'Navigate to a specific slide.',
            parameters: {
              type: 'object',
              properties: {
                slide_number: { type: 'integer', description: 'Slide number (1-indexed)' },
              },
              required: ['slide_number'],
            },
          },
          {
            type: 'function',
            name: 'resume_presentation',
            description: 'Resume the presentation from where it was before the user interrupted.',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    });
  }, [sendEvent]);

  // Handle incoming server events
  const handleServerEvent = useCallback((event: Record<string, unknown>) => {
    const type = event.type as string;

    switch (type) {
      case 'session.created':
        console.log('[Realtime] Session created — configuring...');
        setIsConnected(true);
        updateInstructions(slidesRef.current, currentSlideRef.current);
        break;

      case 'session.updated':
        console.log('[Realtime] Session ready');
        setIsSessionReady(true);
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[Realtime] Speech detected, AI speaking:', isSpeakingRef.current);
        setIsListening(true);

        if (isSpeakingRef.current) {
          // User is speaking OVER the AI → treat as voice interruption
          // Stop the AI immediately so the user can be heard
          console.log('[Realtime] Voice interruption — stopping AI');
          clearAudioFinishTimeout();
          sendEvent({ type: 'response.cancel' });
          sendEvent({ type: 'output_audio_buffer.clear' });
          isSpeakingRef.current = false;
          accumulatedTranscriptRef.current = '';
          setIsSpeaking(false);
          userInterruptedRef.current = true;
          optionsRef.current.onUserSpeechStart?.();
        } else {
          // AI is silent — genuine user speech
          userInterruptedRef.current = true;
          optionsRef.current.onUserSpeechStart?.();
        }
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[Realtime] Speech stopped, AI speaking:', isSpeakingRef.current, 'userInterrupted:', userInterruptedRef.current);
        setIsListening(false);

        // With create_response:false, we must manually trigger responses.
        if (userInterruptedRef.current) {
          // User deliberately interrupted (via voice) → always create response
          userInterruptedRef.current = false;
          console.log('[Realtime] User interrupted — creating response to their question');
          sendEvent({ type: 'response.create' });
        } else if (!isSpeakingRef.current) {
          // AI is not speaking — check echo buffer (short, 800ms)
          const timeSinceAiDone = Date.now() - lastResponseDoneTimeRef.current;
          if (timeSinceAiDone > 800) {
            console.log('[Realtime] Genuine user speech — creating response');
            sendEvent({ type: 'response.create' });
          } else {
            console.log('[Realtime] Ignoring trailing echo (', timeSinceAiDone, 'ms since AI done)');
          }
        }
        // If AI is still speaking and user didn't interrupt, it's likely echo — ignore
        break;

      // --- Speaking detection ---
      // In WebRTC mode, audio binary goes through the media track, NOT the data channel.
      // response.audio.delta / response.output_audio.delta may NEVER arrive here.
      // Kept as fallback.
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (!isSpeakingRef.current) {
          isSpeakingRef.current = true;
          speakingStartTimeRef.current = Date.now();
          accumulatedTranscriptRef.current = '';
          setIsSpeaking(true);
          optionsRef.current.onSpeakingChange?.(true);
          console.log('[Realtime] AI started speaking (audio delta)');
        }
        break;

      case 'response.audio.done':
      case 'response.output_audio.done':
        console.log('[Realtime] AI audio stream done');
        break;

      // PRIMARY speaking detection for WebRTC mode:
      // Transcript delta events ARE sent through the data channel.
      // We also accumulate the text to estimate total audio duration.
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta': {
        const delta = (event as any).delta || '';
        accumulatedTranscriptRef.current += delta;

        if (!isSpeakingRef.current) {
          isSpeakingRef.current = true;
          speakingStartTimeRef.current = Date.now();
          setIsSpeaking(true);
          optionsRef.current.onSpeakingChange?.(true);
          console.log('[Realtime] AI started speaking (transcript delta)');
        }
        break;
      }

      case 'response.done': {
        const wasSpeaking = isSpeakingRef.current;
        const transcript = accumulatedTranscriptRef.current;
        console.log('[Realtime] Response generation complete, wasSpeaking:', wasSpeaking, 'transcript length:', transcript.length);

        if (wasSpeaking) {
          // Estimate how long the audio should take to play
          const estimatedTotalMs = (transcript.length / CHARS_PER_SECOND) * 1000;
          const elapsedMs = Date.now() - speakingStartTimeRef.current;
          const remainingMs = Math.max(0, estimatedTotalMs - elapsedMs);

          console.log(`[Realtime] Audio estimate: total ~${Math.round(estimatedTotalMs / 1000)}s, elapsed ~${Math.round(elapsedMs / 1000)}s, remaining ~${Math.round(remainingMs / 1000)}s`);

          // Clear any previous timeout
          clearAudioFinishTimeout();

          if (remainingMs > 500) {
            // Audio is likely still playing — wait before signaling done
            // Keep isSpeakingRef = true so echo detection still works
            console.log(`[Realtime] Waiting ~${Math.round(remainingMs / 1000)}s for audio playback to finish`);
            audioFinishTimeoutRef.current = setTimeout(() => {
              audioFinishTimeoutRef.current = null;
              finishSpeaking();

              // Handle deferred function call responses
              if (pendingFunctionResultRef.current) {
                pendingFunctionResultRef.current = false;
                console.log('[Realtime] Sending deferred response.create');
                sendEvent({ type: 'response.create' });
              }
            }, remainingMs);
          } else {
            // Generation took long enough that playback should be done (or nearly)
            finishSpeaking();

            if (pendingFunctionResultRef.current) {
              pendingFunctionResultRef.current = false;
              console.log('[Realtime] Sending deferred response.create');
              sendEvent({ type: 'response.create' });
            }
          }
        } else {
          // Non-audio response (e.g., function call only)
          if (pendingFunctionResultRef.current) {
            pendingFunctionResultRef.current = false;
            console.log('[Realtime] Sending deferred response.create');
            sendEvent({ type: 'response.create' });
          }
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

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
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
          if (slideNum >= 1 && slideNum <= slidesRef.current.length) {
            optionsRef.current.onNavigate?.({ type: 'navigate', slideNumber: slideNum });
            sendEvent({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ success: true, navigated_to: slideNum }) },
            });
          } else {
            sendEvent({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ success: false, error: 'Invalid slide number' }) },
            });
          }
          pendingFunctionResultRef.current = true;

        } else if (name === 'resume_presentation') {
          console.log('[Realtime] Resuming presentation');
          optionsRef.current.onResume?.();
          sendEvent({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ success: true, resumed: true }) },
          });
          pendingFunctionResultRef.current = true;
        }
        break;
      }

      case 'error': {
        const errMsg = (event as any).error?.message || 'Realtime API error';
        console.error('[Realtime] Error:', errMsg);
        if (!errMsg.toLowerCase().includes('cancellation failed')) {
          setError(errMsg);
        }
        break;
      }

      default:
        // Log unhandled events — skip high-frequency ones
        if (
          !type.includes('audio.delta') &&
          !type.includes('audio_transcript.delta')
        ) {
          console.log('[Realtime] Unhandled event:', type);
        }
        break;
    }
  }, [updateInstructions, sendEvent, clearAudioFinishTimeout, finishSpeaking]);

  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  // Connect
  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsSessionReady(false);
      console.log('[Realtime] Connecting...');

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        console.log('[Realtime] Got remote audio track');
        audioEl.srcObject = e.streams[0];
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      pc.addTrack(stream.getTracks()[0]);

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;
      dc.addEventListener('open', () => console.log('[Realtime] Data channel open'));
      dc.addEventListener('message', (e) => {
        try { handleServerEventRef.current(JSON.parse(e.data)); } catch { /* ignore */ }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch('/api/realtime/session', {
        method: 'POST',
        body: offer.sdp,
        headers: { 'Content-Type': 'application/sdp' },
      });

      if (!sdpResponse.ok) {
        throw new Error(`Session failed: ${sdpResponse.status} ${await sdpResponse.text()}`);
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() });
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

  const disconnect = useCallback(() => {
    clearAudioFinishTimeout();
    dcRef.current?.close(); dcRef.current = null;
    pcRef.current?.close(); pcRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    if (audioElRef.current) { audioElRef.current.srcObject = null; audioElRef.current = null; }
    setIsConnected(false); setIsSessionReady(false); setIsSpeaking(false); setIsListening(false);
  }, [clearAudioFinishTimeout]);

  // Narrate a slide — cancel any in-progress response, then create new one
  const speakText = useCallback((text: string) => {
    console.log('[Realtime] speakText called');

    // Cancel any pending audio-finish timeout from previous response
    clearAudioFinishTimeout();

    // Always clear buffered audio and cancel active response before new narration
    sendEvent({ type: 'response.cancel' });
    sendEvent({ type: 'output_audio_buffer.clear' });
    isSpeakingRef.current = false;
    pendingFunctionResultRef.current = false;
    accumulatedTranscriptRef.current = '';
    userInterruptedRef.current = false;

    sendEvent({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    sendEvent({ type: 'response.create' });
  }, [sendEvent, clearAudioFinishTimeout]);

  // Interrupt AI — user pressed Space or spoke
  const interrupt = useCallback(() => {
    clearAudioFinishTimeout();
    sendEvent({ type: 'response.cancel' });
    sendEvent({ type: 'output_audio_buffer.clear' });
    pendingFunctionResultRef.current = false;
    accumulatedTranscriptRef.current = '';
    userInterruptedRef.current = false;
    isSpeakingRef.current = false;
    setIsSpeaking(false);
    optionsRef.current.onSpeakingChange?.(false);
  }, [sendEvent, clearAudioFinishTimeout]);

  useEffect(() => {
    return () => {
      clearAudioFinishTimeout();
      dcRef.current?.close();
      pcRef.current?.close();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [clearAudioFinishTimeout]);

  return {
    connect, disconnect, updateContext, updateInstructions,
    speakText, interrupt, sendEvent,
    isConnected, isSessionReady, isSpeaking, isListening, error,
  };
}
