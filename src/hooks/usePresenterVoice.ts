import { useState, useCallback, useRef } from 'react';
import { Slide } from '../types/slides';
import { useDeepgramSTT } from './useDeepgramSTT';
import { useElevenLabsTTS } from './useElevenLabsTTS';

/**
 * Main orchestration hook: Deepgram STT + OpenAI GPT + ElevenLabs TTS.
 *
 * Replaces useRealtimeVoice with a 3-service pipeline.
 * Same external interface so App.tsx requires minimal changes.
 */

interface NavigationAction {
  type: 'navigate';
  slideNumber: number;
}

interface UsePresenterVoiceOptions {
  onNavigate?: (action: NavigationAction) => void;
  onTranscript?: (text: string, role: 'user' | 'assistant') => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onUserSpeechStart?: () => void;
  onResume?: () => void;
  /** 0-based index of slide to return to after Q&A (null = none) */
  getReturnSlideIndex?: () => number | null;
}

// OpenAI function definitions for slide navigation
// NOTE: resume_presentation is handled entirely in code (qaFlowStateRef) — NOT exposed to the model.
const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'navigate_to_slide',
      description: 'Navigate to a specific slide number. Use ONLY when answering a question about a DIFFERENT slide.',
      parameters: {
        type: 'object',
        properties: {
          slide_number: { type: 'integer', description: 'Slide number (1-indexed)' },
        },
        required: ['slide_number'],
      },
    },
  },
];

// Regexes for programmatic Q&A flow enforcement
const AFFIRMATIVE_RE = /^\s*(yes|yeah|yep|yup|good|great|thanks|thank you|that helps|sure|ok|okay|perfect|awesome|got it|understood|correct|exactly|right|absolutely|definitely|of course|certainly)\b/i;
const RESUME_CONFIRM_RE = /^\s*(yes|yeah|yep|yup|continue|sure|go ahead|please|ok|okay|carry on|resume|go on|let'?s go|let'?s continue|absolutely|of course|certainly|definitely)\b/i;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
};

export function usePresenterVoice(options: UsePresenterVoiceOptions = {}) {
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const slidesRef = useRef<Slide[]>([]);
  const currentSlideRef = useRef(0);

  // Conversation history for OpenAI
  const messagesRef = useRef<ChatMessage[]>([]);
  // Whether we're currently processing a user utterance (prevents double-processing)
  const isProcessingRef = useRef(false);
  // Flag: TTS is currently playing
  const isTTSSpeakingRef = useRef(false);
  // Ignore next utterance (speech was detected during TTS = likely echo)
  const ignoreNextUtteranceRef = useRef(false);

  /**
   * Q&A flow state — enforced programmatically so we never rely on the model:
   * 'normal'                   → default, send everything to GPT
   * 'awaiting_answer_satisfied'→ AI just answered a question; next short affirmative
   *                              triggers "Shall I resume?" without calling GPT
   * 'awaiting_resume_confirm'  → AI asked "Shall I resume?"; next affirmative
   *                              calls onResume() without calling GPT
   */
  const qaFlowStateRef = useRef<'normal' | 'awaiting_answer_satisfied' | 'awaiting_resume_confirm'>('normal');

  // --- Build system prompt ---
  const buildSystemPrompt = useCallback((slides: Slide[], currentSlide: number): string => {
    const slideList = slides
      .map((s, i) => {
        const marker = i === currentSlide ? ' [CURRENT]' : '';
        return `  Slide ${i + 1}${marker}: "${s.title}"${s.content ? ` — ${s.content}` : ''}`;
      })
      .join('\n');

    const returnIdx = optionsRef.current.getReturnSlideIndex?.() ?? null;
    const resumeLine = returnIdx !== null
      ? `\nRESUME CONTEXT: You were explaining slide ${returnIdx + 1} before the viewer asked a question. The system will handle returning to that slide when appropriate.\n`
      : '';

    return `You are a professional AI presentation assistant. You present slides naturally, like a real human presenter.

ALL SLIDES (with their content):
${slideList}

You are currently on slide ${currentSlide + 1} of ${slides.length}.${resumeLine}

MODE — NARRATION (when you receive a [NARRATION] prompt):
- Explain the current slide content naturally and concisely.
- Do NOT ask the viewer any questions. Do NOT say "does that answer your question".
- Just narrate the content and stop. The system will advance to the next slide automatically.

MODE — Q&A (when the viewer asks a question):
1. If the question is about a DIFFERENT slide, call navigate_to_slide first, then answer.
2. If the question is about the CURRENT slide, just answer directly.
3. End your answer with: "Does that answer your question?"
4. The system will handle the rest of the resume flow automatically — do NOT call resume_presentation yourself. Do NOT ask "shall I resume" yourself. Just answer the question and end with "Does that answer your question?"
Keep responses concise (2-4 sentences for narration, 1-3 sentences for Q&A answers).`;
  }, []);

  // --- Send message to OpenAI and handle response ---
  const sendToOpenAI = useCallback(async (userText: string, isNarration: boolean): Promise<string | null> => {
    const systemPrompt = buildSystemPrompt(slidesRef.current, currentSlideRef.current);

    // Update system message
    if (messagesRef.current.length === 0 || messagesRef.current[0].role !== 'system') {
      messagesRef.current.unshift({ role: 'system', content: systemPrompt });
    } else {
      messagesRef.current[0].content = systemPrompt;
    }

    // Add user message
    messagesRef.current.push({ role: 'user', content: userText });

    // Keep conversation manageable (last 20 messages + system)
    if (messagesRef.current.length > 22) {
      messagesRef.current = [
        messagesRef.current[0], // system
        ...messagesRef.current.slice(-20),
      ];
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: messagesRef.current,
          tools: isNarration ? undefined : TOOLS, // Only provide tools during Q&A
          tool_choice: isNarration ? undefined : 'auto',
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Chat API error: ${response.status}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error('No response from OpenAI');

      const message = choice.message;

      // Handle function calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        // Add assistant message with tool calls to history
        messagesRef.current.push({
          role: 'assistant',
          content: message.content,
          tool_calls: message.tool_calls,
        });

        for (const toolCall of message.tool_calls) {
          const fn = toolCall.function;
          const args = JSON.parse(fn.arguments || '{}');

          console.log('[PresenterVoice] Function call:', fn.name, args);

          if (fn.name === 'navigate_to_slide' && args.slide_number) {
            const slideNum = parseInt(args.slide_number, 10);
            if (slideNum >= 1 && slideNum <= slidesRef.current.length) {
              optionsRef.current.onNavigate?.({ type: 'navigate', slideNumber: slideNum });
              // Update current slide ref for next system prompt
              currentSlideRef.current = slideNum - 1;

              messagesRef.current.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ success: true, navigated_to: slideNum }),
              });
            } else {
              messagesRef.current.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ success: false, error: 'Invalid slide number' }),
              });
            }
          } else {
            // Unknown tool call — respond so we don't break the message chain
            messagesRef.current.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ success: false, error: 'Unknown function' }),
            });
          }
        }

        // After handling tool calls, get the AI's text follow-up (no more tools)
        const followUp = await sendToOpenAI_internal();
        return followUp;
      }

      // Regular text response
      if (message.content) {
        messagesRef.current.push({ role: 'assistant', content: message.content });
        return message.content;
      }

      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chat failed';
      console.error('[PresenterVoice] OpenAI error:', msg);
      setError(msg);
      return null;
    }
  }, [buildSystemPrompt]);

  // Internal: get text follow-up from OpenAI after tool calls.
  // No tools are passed — the model can only respond with text.
  const sendToOpenAI_internal = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: messagesRef.current,
          // No tools — follow-up must be text only
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Chat API error: ${response.status}`);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;

      if (message?.content) {
        messagesRef.current.push({ role: 'assistant', content: message.content });
        return message.content;
      }

      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chat failed';
      console.error('[PresenterVoice] OpenAI follow-up error:', msg);
      return null;
    }
  }, []);

  // --- ElevenLabs TTS ---
  const tts = useElevenLabsTTS({
    onSpeakingChange: (speaking) => {
      isTTSSpeakingRef.current = speaking;
      setIsSpeaking(speaking);
      console.log('[PresenterVoice] TTS speaking:', speaking);
      optionsRef.current.onSpeakingChange?.(speaking);
    },
  });

  const echoIgnoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Deepgram STT ---
  const stt = useDeepgramSTT({
    onSpeechStart: () => {
      if (isTTSSpeakingRef.current) {
        // Mic picked up AI's voice (echo) — ignore this speech burst
        if (echoIgnoreTimeoutRef.current) clearTimeout(echoIgnoreTimeoutRef.current);
        ignoreNextUtteranceRef.current = true;
        // Safety: clear flag after 2s in case echo never produces utterance_end
        echoIgnoreTimeoutRef.current = setTimeout(() => {
          echoIgnoreTimeoutRef.current = null;
          ignoreNextUtteranceRef.current = false;
        }, 2000);
        return;
      }
      // Genuine user speech — clear any stale echo flag and process
      if (echoIgnoreTimeoutRef.current) {
        clearTimeout(echoIgnoreTimeoutRef.current);
        echoIgnoreTimeoutRef.current = null;
      }
      ignoreNextUtteranceRef.current = false;
      optionsRef.current.onUserSpeechStart?.();
    },

    onTranscript: (text, isFinal) => {
      if (isFinal && !isTTSSpeakingRef.current) {
        setIsListening(true);
        optionsRef.current.onTranscript?.(text, 'user');
      }
    },

    onUtteranceEnd: async (fullText) => {
      setIsListening(false);

      if (ignoreNextUtteranceRef.current) {
        if (echoIgnoreTimeoutRef.current) {
          clearTimeout(echoIgnoreTimeoutRef.current);
          echoIgnoreTimeoutRef.current = null;
        }
        ignoreNextUtteranceRef.current = false;
        return;
      }
      if (!fullText.trim() || isProcessingRef.current) return;

      const trimmed = fullText.trim();
      console.log('[PresenterVoice] Processing user utterance:', trimmed, '| qaState:', qaFlowStateRef.current);
      isProcessingRef.current = true;
      optionsRef.current.onTranscript?.(trimmed, 'user');

      try {
        // ────────────────────────────────────────────────────────
        // Programmatic Q&A flow — steps 2 & 3 handled in code
        // ────────────────────────────────────────────────────────

        // STEP 3: User confirms resume → call onResume directly, no GPT
        if (qaFlowStateRef.current === 'awaiting_resume_confirm' && RESUME_CONFIRM_RE.test(trimmed)) {
          console.log('[PresenterVoice] ✓ QA STEP 3: User confirmed resume with "' + trimmed + '"');
          qaFlowStateRef.current = 'normal';
          // Add to conversation history for context
          messagesRef.current.push({ role: 'user', content: trimmed });
          messagesRef.current.push({ role: 'assistant', content: 'Resuming the presentation now.' });
          optionsRef.current.onTranscript?.('Resuming the presentation.', 'assistant');
          console.log('[PresenterVoice] ✓ Calling onResume()...');
          optionsRef.current.onResume?.();
          return; // finally block sets isProcessingRef = false
        }

        // STEP 2: User says "yes" to "does that answer?" → ask "shall I resume?"
        if (qaFlowStateRef.current === 'awaiting_answer_satisfied' && AFFIRMATIVE_RE.test(trimmed)) {
          console.log('[PresenterVoice] ✓ QA STEP 2: User satisfied with "' + trimmed + '", asking about resume');
          const resumeQuestion = 'Shall I resume the presentation from where I left off?';
          qaFlowStateRef.current = 'awaiting_resume_confirm';
          messagesRef.current.push({ role: 'user', content: trimmed });
          messagesRef.current.push({ role: 'assistant', content: resumeQuestion });
          optionsRef.current.onTranscript?.(resumeQuestion, 'assistant');
          await tts.speak(resumeQuestion);
          console.log('[PresenterVoice] ✓ Asked resume question, waiting for confirmation');
          return; // finally block sets isProcessingRef = false
        }

        // If user said something else (follow-up question, etc.) → reset and send to GPT
        if (qaFlowStateRef.current !== 'normal') {
          console.log('[PresenterVoice] QA flow: resetting to normal, user said something unexpected');
          qaFlowStateRef.current = 'normal';
        }

        // ────────────────────────────────────────────────────────
        // Normal path — send to OpenAI (user asking a question)
        // ────────────────────────────────────────────────────────
        // CRITICAL: Notify App that user is asking a question, so presentation pauses
        // This handles cases where speech was ignored initially (echo) but utterance came through later
        optionsRef.current.onUserSpeechStart?.();
        
        const aiResponse = await sendToOpenAI(trimmed, false);

        if (aiResponse) {
          console.log('[PresenterVoice] AI response:', aiResponse.slice(0, 80) + '...');

          // Append "Does that answer your question?" if model didn't include it
          const DOES_THAT_ANSWER_RE = /does that (answer|help)|answer your question/i;
          let fullResponse = aiResponse;
          if (!DOES_THAT_ANSWER_RE.test(aiResponse)) {
            fullResponse = aiResponse.replace(/[.!?]?\s*$/, '. ') + 'Does that answer your question?';
          }

          optionsRef.current.onTranscript?.(fullResponse, 'assistant');

          // After ANY Q&A response, enter the "awaiting_answer_satisfied" state
          // so the next "yes" triggers "shall I resume?" automatically
          qaFlowStateRef.current = 'awaiting_answer_satisfied';
          console.log('[PresenterVoice] QA flow: set to awaiting_answer_satisfied');

          // Speak the response via ElevenLabs
          await tts.speak(fullResponse);
        }
      } finally {
        isProcessingRef.current = false;
      }
    },
  });

  // --- Public API ---

  const connect = useCallback(async () => {
    setError(null);
    messagesRef.current = [];
    console.log('[PresenterVoice] Connecting...');

    await stt.connect();
    // stt.connect() does not throw — it sets error state on failure.
    // We still mark connected so narration (OpenAI + ElevenLabs) can run.
    setIsConnected(true);
    console.log('[PresenterVoice] Connected');
  }, [stt]);

  const disconnect = useCallback(() => {
    stt.disconnect();
    tts.stop();
    messagesRef.current = [];
    isProcessingRef.current = false;
    qaFlowStateRef.current = 'normal';
    setIsConnected(false);
    setIsSpeaking(false);
    setIsListening(false);
    console.log('[PresenterVoice] Disconnected');
  }, [stt, tts]);

  const updateContext = useCallback((slides: Slide[], currentSlide: number) => {
    slidesRef.current = slides;
    currentSlideRef.current = currentSlide;
  }, []);

  const updateInstructions = useCallback((_slides: Slide[], _currentSlide: number) => {
    // For the GPT pipeline, instructions are built fresh for each call in buildSystemPrompt.
    // This is a no-op but maintains API compatibility with useRealtimeVoice.
    slidesRef.current = _slides;
    currentSlideRef.current = _currentSlide;
  }, []);

  /**
   * Narrate: send a prompt to OpenAI, speak the response via ElevenLabs.
   */
  const speakText = useCallback(async (prompt: string) => {
    // Stop any current speech
    tts.stop();
    stt.resetTranscript();
    isProcessingRef.current = true;
    qaFlowStateRef.current = 'normal'; // Reset Q&A state when narration starts

    console.log('[PresenterVoice] speakText:', prompt.slice(0, 60) + '...');

    try {
      const aiResponse = await sendToOpenAI(prompt, true);

      if (aiResponse) {
        optionsRef.current.onTranscript?.(aiResponse, 'assistant');
        await tts.speak(aiResponse);
      } else {
        // No response — signal done so auto-advance still works
        optionsRef.current.onSpeakingChange?.(false);
      }
    } catch (err) {
      console.error('[PresenterVoice] speakText error:', err);
      optionsRef.current.onSpeakingChange?.(false);
    } finally {
      isProcessingRef.current = false;
    }
  }, [tts, stt, sendToOpenAI]);

  /**
   * Interrupt: stop TTS and clear state.
   */
  const interrupt = useCallback(() => {
    tts.stop();
    stt.resetTranscript();
    isProcessingRef.current = false;
    console.log('[PresenterVoice] Interrupted');
  }, [tts, stt]);

  const sendEvent = useCallback((_event: Record<string, unknown>) => {
    // No-op — maintained for API compatibility with useRealtimeVoice
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
    isSessionReady: isConnected, // For compat — connected = ready in this pipeline
    isSpeaking,
    isListening,
    error: error || stt.error || tts.error,
  };
}
