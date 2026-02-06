import { useState, useRef, useCallback, useEffect } from 'react';

interface VoiceAssistantState {
  isConnected: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  sessionReady: boolean;
  error: string | null;
}

interface SlideInfo {
  title: string;
  content: string;
}

interface UseVoiceAssistantProps {
  onNavigateToSlide?: (slideNumber: number) => void;
  onGoToSlideAndExplain?: (slideIndex: number, isLastSlide: boolean, fromUserRequest?: boolean) => void;
  onReturnToPreviousSlide?: () => void;
  onResponseComplete?: () => void;
  totalSlides?: number;
  currentSlideIndex?: number;
  slides?: SlideInfo[];
}

export const useVoiceAssistant = ({
  onNavigateToSlide,
  onGoToSlideAndExplain,
  onReturnToPreviousSlide,
  onResponseComplete,
  totalSlides = 5,
  currentSlideIndex = 0,
  slides = [],
}: UseVoiceAssistantProps = {}) => {
  const [state, setState] = useState<VoiceAssistantState>({
    isConnected: false,
    isListening: false,
    isSpeaking: false,
    sessionReady: false,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const currentSlideRef = useRef(currentSlideIndex);
  const onGoToSlideRef = useRef(onGoToSlideAndExplain);
  const onReturnToPreviousRef = useRef(onReturnToPreviousSlide);
  const onResponseCompleteRef = useRef(onResponseComplete);
  const skipNextResponseCompleteRef = useRef(false);
  currentSlideRef.current = currentSlideIndex;
  onGoToSlideRef.current = onGoToSlideAndExplain;
  onReturnToPreviousRef.current = onReturnToPreviousSlide;
  onResponseCompleteRef.current = onResponseComplete;

  const slidesSummary = slides
    .map((s, i) => `Slide ${i + 1}: "${s.title}" - ${s.content}`)
    .join('. ');

  const prepareAudio = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  }, []);

  const waitForConnection = useCallback((): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const check = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          clearInterval(check);
          resolve();
        } else if (wsRef.current?.readyState === WebSocket.CLOSED) {
          clearInterval(check);
          reject(new Error('Connection failed'));
        }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }, []);

  const connect = useCallback(async () => {
    try {
      const apiKey = import.meta.env.VITE_OPENAI_API_KEY;

      if (!apiKey) {
        throw new Error('OpenAI API key not found');
      }

      const ws = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
        ['realtime', `openai-insecure-api-key.${apiKey}`, 'openai-beta.realtime-v1']
      );

      wsRef.current = ws;

      ws.onopen = () => {
        setState(prev => ({ ...prev, isConnected: true, sessionReady: false, error: null }));
        setTimeout(() => {
          setState(prev => (prev.isConnected && !prev.sessionReady ? { ...prev, sessionReady: true } : prev));
        }, 2500);

        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: `You are a conversational AI presentation assistant for EchoLeads. The presentation has ${totalSlides} slides.

            SLIDE CONTENT - ALWAYS use navigate_to_slide to match user questions:
            ${slidesSummary}

            CRITICAL: When the user asks about ANY topic (lead discovery, outreach, analytics, etc.) or says a slide number, you MUST call navigate_to_slide with the matching slide. Never respond with only text - always call the function to go to that slide.

            Slide matching: "lead"/"discovery" → slide 2, "outreach"/"automated" → slide 3, "analytics"/"insights" → slide 4, "grow"/"start" → slide 5, "welcome" → slide 1.

            When the user says "continue", "go back", "resume", or "return", call return_to_previous_slide.

            During automatic flow, use advance_to_next_slide after explaining. Never on the last slide.

            Be concise.`,
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            tools: [
              {
                type: 'function',
                name: 'navigate_to_slide',
                description: 'Go to a slide. Use when user asks about content (match to slide) or says a slide number. E.g. "lead discovery" → slide 2, "automated outreach" → slide 3.',
                parameters: {
                  type: 'object',
                  properties: {
                    slide_number: {
                      type: 'number',
                      description: `Slide 1-${totalSlides}. Match user question to slide content.`,
                    },
                  },
                  required: ['slide_number'],
                },
              },
              {
                type: 'function',
                name: 'return_to_previous_slide',
                description: 'Return to the slide user was on before asking a question. Use when user says "continue", "go back", "resume", "that\'s enough", "return".',
                parameters: { type: 'object', properties: {} },
              },
              {
                type: 'function',
                name: 'advance_to_next_slide',
                description: 'Advance to next slide during automatic flow. Do NOT call on last slide.',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
        }));
      };

      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'session.updated' || data.type === 'session.created') {
          setState(prev => ({ ...prev, sessionReady: true }));
        }

        if ((data.type === 'response.audio.delta' || data.type === 'response.output_audio.delta') && data.delta) {
          setState(prev => ({ ...prev, isSpeaking: true }));

          if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext({ sampleRate: 24000 });
            audioContextRef.current.resume();
          }

          const binary = atob(data.delta);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }

          const pcm16 = new Int16Array(bytes.buffer);
          const float32 = new Float32Array(pcm16.length);
          for (let i = 0; i < pcm16.length; i++) {
            float32[i] = pcm16[i] / 32768.0;
          }

          const audioBuffer = audioContextRef.current.createBuffer(1, float32.length, 24000);
          audioBuffer.getChannelData(0).set(float32);

          const source = audioContextRef.current.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioContextRef.current.destination);
          source.start();

        } else if (data.type === 'response.audio.done' || data.type === 'response.output_audio.done') {
          setState(prev => ({ ...prev, isSpeaking: false }));
          if (!skipNextResponseCompleteRef.current) onResponseCompleteRef.current?.();
          skipNextResponseCompleteRef.current = false;
        } else if (data.type === 'response.done') {
          setState(prev => ({ ...prev, isSpeaking: false }));
          if (!skipNextResponseCompleteRef.current) onResponseCompleteRef.current?.();
          skipNextResponseCompleteRef.current = false;
        } else if (data.type === 'input_audio_buffer.speech_started') {
          console.log('Speech started');
        } else if (data.type === 'input_audio_buffer.speech_stopped') {
          console.log('Speech stopped');
        } else if (data.type === 'response.function_call_arguments.done') {
          const functionName = data.name;
          const callId = data.call_id;
          const args = data.arguments ? JSON.parse(data.arguments) : {};

          const sendFunctionOutputAndContinue = (output: object) => {
            ws.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(output),
              },
            }));
            setTimeout(() => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'response.create' }));
              }
            }, 400);
          };

          skipNextResponseCompleteRef.current = true;
          if (functionName === 'navigate_to_slide' && onGoToSlideRef.current) {
            const slideNumber = args.slide_number ?? 1;
            const slideIndex = Math.max(0, Math.min(slideNumber - 1, totalSlides - 1));
            const isLastSlide = slideIndex === totalSlides - 1;
            onGoToSlideRef.current(slideIndex, isLastSlide, true);
            sendFunctionOutputAndContinue({ success: true, message: `Showing slide ${slideIndex + 1}.` });
          } else if (functionName === 'return_to_previous_slide' && onReturnToPreviousRef.current) {
            onReturnToPreviousRef.current();
            sendFunctionOutputAndContinue({ success: true, message: 'Returned to previous slide.' });
          } else if (functionName === 'advance_to_next_slide' && onGoToSlideRef.current) {
            const currentIdx = currentSlideRef.current;
            const nextIdx = currentIdx + 1;

            if (nextIdx >= totalSlides) {
              sendFunctionOutputAndContinue({
                success: false,
                message: 'Already on the last slide. Give a closing summary.',
              });
            } else {
              onGoToSlideRef.current(nextIdx, false, false);
              sendFunctionOutputAndContinue({ success: true, message: `Advanced to slide ${nextIdx + 1}.` });
            }
          }
        } else if (data.type === 'error') {
          const errMsg = data.error?.message || data.error?.code || JSON.stringify(data.error) || 'An error occurred';
          console.error('OpenAI error (full):', JSON.stringify(data, null, 2));
          setState(prev => ({ ...prev, isConnected: false, sessionReady: false, error: errMsg }));
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setState(prev => ({ ...prev, error: 'Connection error occurred' }));
      };

      ws.onclose = (event) => {
        const closeReason = event.reason || (event.code ? `Code ${event.code}` : '');
        if (closeReason && !event.wasClean) {
          setState(prev => ({ ...prev, isConnected: false, sessionReady: false, isListening: false, isSpeaking: false, error: prev.error || closeReason }));
        } else {
          setState(prev => ({ ...prev, isConnected: false, sessionReady: false, isListening: false, isSpeaking: false }));
        }
      };

    } catch (error) {
      console.error('Failed to connect:', error);
      setState(prev => ({ ...prev, error: 'Failed to connect to AI' }));
    }
  }, []);

  const startListening = useCallback(async () => {
    try {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        await connect();
        await waitForConnection();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      mediaStreamRef.current = stream;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;
      processor.connect(gainNode);
      gainNode.connect(ctx.destination);

      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(inputData.length);

          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          const base64Audio = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(pcm16.buffer))));

          wsRef.current.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: base64Audio,
          }));
        }
      };

      setState(prev => ({ ...prev, isListening: true }));
    } catch (error) {
      console.error('Failed to start listening:', error);
      setState(prev => ({ ...prev, error: 'Microphone access denied' }));
    }
  }, [connect, waitForConnection]);

  const stopListening = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    setState(prev => ({ ...prev, isListening: false }));
  }, []);

  const sendTextMessage = useCallback((message: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: message,
            },
          ],
        },
      }));

      wsRef.current.send(JSON.stringify({
        type: 'response.create',
      }));
    }
  }, []);

  const disconnect = useCallback(() => {
    stopListening();

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, [stopListening]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    ...state,
    connect,
    disconnect,
    prepareAudio,
    startListening,
    stopListening,
    sendTextMessage,
  };
};
