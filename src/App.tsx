import { useState, useEffect, useRef, useCallback } from 'react';
import { SlideView } from './components/SlideView';
import { SlideControls } from './components/SlideControls';
import { AIAvatar } from './components/AIAvatar';
import { WelcomeModal } from './components/WelcomeModal';
import { useRealtimeVoice } from './hooks/useRealtimeVoice';
import { Slide } from './types/slides';

function App() {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [showWelcome, setShowWelcome] = useState(true);
  const [presentationStarted, setPresentationStarted] = useState(false);
  const [userMessage, setUserMessage] = useState('');
  const [, setAiMessage] = useState('');

  const isAutoAdvancingRef = useRef(true);
  const lastSpokenSlideRef = useRef(-1);
  const advanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSlideRef = useRef(0);
  const slidesRef = useRef<Slide[]>([]);
  // The slide the AI was presenting before user interrupted (to return to after Q&A)
  const returnSlideRef = useRef<number | null>(null);
  currentSlideRef.current = currentSlide;
  slidesRef.current = slides;

  // --- Helpers (defined before useRealtimeVoice so callbacks can reference them) ---
  const clearAdvanceTimeout = useCallback(() => {
    if (advanceTimeoutRef.current) {
      clearTimeout(advanceTimeoutRef.current);
      advanceTimeoutRef.current = null;
    }
  }, []);

  const scheduleAdvance = useCallback(() => {
    clearAdvanceTimeout();
    advanceTimeoutRef.current = setTimeout(() => {
      advanceTimeoutRef.current = null;
      if (isAutoAdvancingRef.current) {
        setCurrentSlide((prev) => {
          if (prev < slidesRef.current.length - 1) return prev + 1;
          return prev;
        });
      }
    }, 2000);
  }, [clearAdvanceTimeout]);

  // --- Realtime Voice ---
  const {
    connect,
    disconnect,
    updateContext,
    updateInstructions,
    speakText,
    interrupt,
    isConnected,
    isSessionReady,
    isSpeaking,
    isListening,
    error: realtimeError,
  } = useRealtimeVoice({
    onNavigate: (action) => {
      if (action.type === 'navigate') {
        const idx = action.slideNumber - 1;
        if (idx >= 0 && idx < slidesRef.current.length) {
          console.log('[App] Navigating to slide', action.slideNumber);
          lastSpokenSlideRef.current = idx;
          setCurrentSlide(idx);
          updateInstructions(slidesRef.current, idx);
        }
      }
    },

    onTranscript: (text, role) => {
      if (role === 'user') {
        setUserMessage(text);
        // If we get a genuine user transcript while auto-advancing,
        // pause and enter Q&A mode (this catches voice interruptions
        // that onUserSpeechStart might miss due to echo filtering)
        if (isAutoAdvancingRef.current && text.length > 3) {
          console.log('[App] User transcript detected — entering Q&A mode');
          returnSlideRef.current = currentSlideRef.current;
          isAutoAdvancingRef.current = false;
          clearAdvanceTimeout();
        }
        setTimeout(() => setUserMessage(''), 5000);
      } else {
        setAiMessage(text);
        setTimeout(() => setAiMessage(''), 8000);
      }
    },

    onSpeakingChange: (speaking) => {
      if (!speaking && isAutoAdvancingRef.current) {
        // AI finished narrating a slide → schedule next slide
        scheduleAdvance();
      }
      // If not auto-advancing (user Q&A mode), do NOT advance.
      // The AI will ask "are you satisfied?" and call resume_presentation.
    },

    onUserSpeechStart: () => {
      // User started speaking → pause the presentation
      if (isAutoAdvancingRef.current) {
        console.log('[App] User interrupted — pausing, saving return slide:', currentSlideRef.current + 1);
        returnSlideRef.current = currentSlideRef.current;
        isAutoAdvancingRef.current = false;
        clearAdvanceTimeout();
      }
    },

    onResume: () => {
      // AI called resume_presentation → go back to where we were and continue
      const returnTo = returnSlideRef.current;
      console.log('[App] Resuming from slide', returnTo !== null ? returnTo + 1 : 'current');

      returnSlideRef.current = null;
      isAutoAdvancingRef.current = true;
      lastSpokenSlideRef.current = -1; // Force re-narration

      if (returnTo !== null && returnTo !== currentSlideRef.current) {
        // Go back to the slide we were on before the interruption
        setCurrentSlide(returnTo);
        updateInstructions(slidesRef.current, returnTo);
      }
      // If already on the right slide, the auto-narrate effect will pick it up
      // because lastSpokenSlideRef was reset to -1
    },
  });

  // --- Update Realtime context when slide changes ---
  useEffect(() => {
    if (isConnected && slides.length > 0) {
      updateContext(slides, currentSlide);
    }
  }, [isConnected, slides, currentSlide, updateContext]);

  // --- Auto-narrate each slide ---
  useEffect(() => {
    if (
      presentationStarted &&
      isSessionReady &&
      slides.length > 0 &&
      isAutoAdvancingRef.current &&
      currentSlide < slides.length &&
      lastSpokenSlideRef.current !== currentSlide
    ) {
      lastSpokenSlideRef.current = currentSlide;
      const slide = slides[currentSlide];
      const isFirst = currentSlide === 0;
      const isLast = currentSlide === slides.length - 1;

      // Update context for current slide
      updateInstructions(slides, currentSlide);

      // Narration prompt — explicitly tells AI to just present, not ask questions
      let prompt: string;
      if (isFirst) {
        prompt = `[NARRATION] Welcome the audience and present slide 1: "${slide.title}". ${slide.content || ''} — Just narrate naturally. Do not ask the viewer any questions.`;
      } else if (isLast) {
        prompt = `[NARRATION] This is the final slide: "${slide.title}". ${slide.content || ''} Wrap up the presentation briefly. Do not ask the viewer any questions.`;
      } else {
        prompt = `[NARRATION] Present slide ${currentSlide + 1}: "${slide.title}". ${slide.content || ''} — Just narrate naturally. Do not ask the viewer any questions.`;
      }

      speakText(prompt);
    }
  }, [presentationStarted, isSessionReady, currentSlide, slides, speakText, updateInstructions]);

  // --- Keyboard controls ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!presentationStarted || slides.length === 0) return;

      // Space = interrupt AI to ask a question
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        if (isSpeaking) {
          if (isAutoAdvancingRef.current) {
            returnSlideRef.current = currentSlideRef.current;
          }
          interrupt();
          clearAdvanceTimeout();
          isAutoAdvancingRef.current = false;
        }
        return;
      }

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        if (currentSlide < slides.length - 1) {
          interrupt();
          clearAdvanceTimeout();
          isAutoAdvancingRef.current = true;
          lastSpokenSlideRef.current = -1;
          returnSlideRef.current = null;
          setCurrentSlide((prev) => prev + 1);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        if (currentSlide > 0) {
          interrupt();
          clearAdvanceTimeout();
          isAutoAdvancingRef.current = true;
          lastSpokenSlideRef.current = -1;
          returnSlideRef.current = null;
          setCurrentSlide((prev) => prev - 1);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [presentationStarted, currentSlide, slides.length, isSpeaking, interrupt, clearAdvanceTimeout]);

  // --- Connect to Realtime API when presentation starts ---
  useEffect(() => {
    if (presentationStarted && !isConnected) {
      connect();
    }
  }, [presentationStarted, isConnected, connect]);

  // --- Handlers ---
  const handleStartPresentation = (uploadedSlides: Slide[]) => {
    clearAdvanceTimeout();
    setSlides(uploadedSlides);
    setShowWelcome(false);
    setCurrentSlide(0);
    setPresentationStarted(true);
    lastSpokenSlideRef.current = -1;
    isAutoAdvancingRef.current = true;
    returnSlideRef.current = null;
  };

  const handleToggle = () => {
    if (isConnected) {
      disconnect();
    } else {
      connect();
    }
  };

  const handleNext = () => {
    if (currentSlide < slides.length - 1) {
      interrupt();
      clearAdvanceTimeout();
      isAutoAdvancingRef.current = true;
      lastSpokenSlideRef.current = -1;
      returnSlideRef.current = null;
      setCurrentSlide((prev) => prev + 1);
    }
  };

  const handlePrevious = () => {
    if (currentSlide > 0) {
      interrupt();
      clearAdvanceTimeout();
      isAutoAdvancingRef.current = true;
      lastSpokenSlideRef.current = -1;
      returnSlideRef.current = null;
      setCurrentSlide((prev) => prev - 1);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-900">
      {showWelcome && <WelcomeModal onStart={handleStartPresentation} />}

      {realtimeError && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 max-w-xl px-4 py-3 bg-red-50 border border-red-200 rounded-lg shadow-lg text-red-800 text-sm">
          <strong>Error:</strong> {realtimeError}
        </div>
      )}

      {userMessage && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 max-w-lg px-5 py-3 bg-white/95 border border-blue-200 rounded-xl shadow-lg text-slate-800 text-sm backdrop-blur-sm">
          <span className="text-blue-500 font-medium mr-2">You:</span> {userMessage}
        </div>
      )}

      {isListening && !userMessage && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 bg-green-50 border border-green-300 rounded-xl shadow-lg text-green-800 text-sm font-medium animate-pulse">
          Listening...
        </div>
      )}

      <div className="absolute top-6 right-6 z-40">
        <AIAvatar
          isListening={isListening}
          isSpeaking={isSpeaking}
          isConnected={isConnected}
          onToggle={handleToggle}
        />
      </div>

      {slides.length > 0 && (
        <>
          <div className="w-full h-full">
            <SlideView
              slide={slides[currentSlide]}
              slideNumber={currentSlide + 1}
              totalSlides={slides.length}
            />
          </div>

          <SlideControls
            currentSlide={currentSlide}
            totalSlides={slides.length}
            onPrevious={handlePrevious}
            onNext={handleNext}
          />

          {/* Hint */}
          {presentationStarted && isSpeaking && (
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 px-4 py-2 bg-black/60 rounded-full text-white/80 text-xs backdrop-blur-sm select-none">
              Press <kbd className="px-1.5 py-0.5 mx-1 bg-white/20 rounded text-white font-mono text-xs">Space</kbd> to interrupt &middot; Just speak to ask a question
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;
