import { useState, useCallback, useRef } from 'react';
import { Slide } from '../types/slides';

export interface NavigationAction {
  type: 'navigate';
  slideNumber: number; // 1-indexed
}

export interface ChatResult {
  text: string;
  action?: NavigationAction;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = any; // OpenAI message format varies (user, assistant, tool)

const NAVIGATE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'navigate_to_slide',
    description: 'Navigate to a specific slide in the presentation. Use when the user asks about a topic, wants to see a specific slide, or says next/previous/continue.',
    parameters: {
      type: 'object',
      properties: {
        slide_number: {
          type: 'integer',
          description: 'The slide number to navigate to (1-indexed)',
        },
      },
      required: ['slide_number'],
    },
  },
};

function buildSystemPrompt(slides: Slide[], currentSlide: number): string {
  // Only include full content for the current slide; titles only for others (saves tokens)
  const slideList = slides
    .map((s, i) => {
      if (i === currentSlide) {
        return `  Slide ${i + 1} [CURRENT]: "${s.title}"${s.content ? ` — ${s.content}` : ''}`;
      }
      return `  Slide ${i + 1}: "${s.title}"`;
    })
    .join('\n');

  return `You are a concise, friendly AI presentation assistant.

SLIDES:
${slideList}

RULES:
- Respond ONLY to the user's actual question. Be brief (1-3 sentences max).
- To navigate: call navigate_to_slide AND include a short spoken response.
- "next"/"continue" → slide ${currentSlide + 2}. "previous"/"back" → slide ${currentSlide}.
- "stop"/"pause" → acknowledge briefly.
- Do NOT add extra content. Be precise and fast.`;
}

/**
 * Chat hook using OpenAI GPT via the backend.
 * Maintains conversation history and supports function calling for navigation.
 */
export function useAIChat() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<Message[]>([]);

  const sendMessage = useCallback(
    async (userText: string, slides: Slide[], currentSlide: number): Promise<ChatResult> => {
      setIsProcessing(true);
      setError(null);

      try {
        const systemPrompt = buildSystemPrompt(slides, currentSlide);

        // Add user message
        messagesRef.current.push({ role: 'user', content: userText });

        // Trim history to last 6 messages (fewer tokens = faster response)
        const recentMessages = messagesRef.current.slice(-6);

        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
            tools: [NAVIGATE_TOOL],
            tool_choice: 'auto',
            max_tokens: 150,
            temperature: 0.5,
          }),
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || `Chat failed: ${resp.status}`);
        }

        const data = await resp.json();
        const choice = data.choices?.[0];
        if (!choice) throw new Error('No response from AI');

        let action: NavigationAction | undefined;
        let responseText = choice.message.content || '';

        // Handle function calls
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          const toolCall = choice.message.tool_calls[0];
          if (toolCall.function.name === 'navigate_to_slide') {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const slideNum = parseInt(args.slide_number, 10);
              if (slideNum >= 1 && slideNum <= slides.length) {
                action = { type: 'navigate', slideNumber: slideNum };
              }
            } catch {
              // ignore malformed function args
            }
          }

          // If GPT returned a function call but no text, compose a fallback
          if (!responseText && action) {
            const targetSlide = slides[action.slideNumber - 1];
            responseText = `Let me take you to slide ${action.slideNumber}. ${targetSlide.title}. ${targetSlide.content || ''}`;
          }

          // Add assistant message with tool call to history
          messagesRef.current.push(choice.message);
          // Add tool result
          messagesRef.current.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: action
              ? `Navigated to slide ${action.slideNumber}`
              : 'Navigation skipped (invalid slide)',
          });
        } else {
          // No function call, just text
          messagesRef.current.push({ role: 'assistant', content: responseText });
        }

        return { text: responseText, action };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Chat failed';
        console.error('[Chat] Error:', msg);
        setError(msg);
        return { text: "Sorry, I had trouble with that. Could you try again?" };
      } finally {
        setIsProcessing(false);
      }
    },
    []
  );

  const resetHistory = useCallback(() => {
    messagesRef.current = [];
  }, []);

  return { sendMessage, resetHistory, isProcessing, error };
}
