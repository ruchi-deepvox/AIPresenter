import { ChevronLeft, ChevronRight } from 'lucide-react';

interface SlideControlsProps {
  currentSlide: number;
  totalSlides: number;
  onPrevious: () => void;
  onNext: () => void;
}

export const SlideControls = ({ currentSlide, totalSlides, onPrevious, onNext }: SlideControlsProps) => {
  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-6 z-30">
      <button
        onClick={onPrevious}
        disabled={currentSlide === 0}
        className={`
          w-12 h-12 rounded-full
          flex items-center justify-center
          transition-all duration-200
          backdrop-blur-xl
          ${currentSlide === 0
            ? 'bg-white/30 text-slate-400 cursor-not-allowed'
            : 'bg-white/80 text-slate-700 hover:bg-white/90 hover:shadow-lg active:scale-95'
          }
        `}
        aria-label="Previous slide"
      >
        <ChevronLeft className="w-6 h-6" strokeWidth={2.5} />
      </button>

      <div className="px-6 py-3 rounded-full bg-white/80 backdrop-blur-xl shadow-lg">
        <span className="text-sm font-medium text-slate-700">
          {currentSlide + 1} / {totalSlides}
        </span>
      </div>

      <button
        onClick={onNext}
        disabled={currentSlide === totalSlides - 1}
        className={`
          w-12 h-12 rounded-full
          flex items-center justify-center
          transition-all duration-200
          backdrop-blur-xl
          ${currentSlide === totalSlides - 1
            ? 'bg-white/30 text-slate-400 cursor-not-allowed'
            : 'bg-white/80 text-slate-700 hover:bg-white/90 hover:shadow-lg active:scale-95'
          }
        `}
        aria-label="Next slide"
      >
        <ChevronRight className="w-6 h-6" strokeWidth={2.5} />
      </button>
    </div>
  );
};
