import { useState } from 'react';
import { Slide } from '../types/slides';

interface SlideViewProps {
  slide: Slide;
  slideNumber?: number;
  totalSlides?: number;
}

export const SlideView = ({ slide, slideNumber, totalSlides }: SlideViewProps) => {
  const hasImages = slide.images.length > 0;
  const [showText, setShowText] = useState(false);

  // --- Image-based slide (the real slide visual) ---
  if (hasImages) {
    // If there's exactly one image, show it full screen as the slide
    // If multiple, show the first as background and the rest in a row
    const mainImage = slide.images[0];

    return (
      <div
        className="w-full h-full relative bg-black flex items-center justify-center transition-all duration-700 ease-out"
        onClick={() => setShowText((prev) => !prev)}
      >
        {/* Main slide image - fills the viewport while maintaining aspect ratio */}
        <img
          src={mainImage}
          alt={slide.title}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
        />

        {/* Additional images thumbnails (if more than 1 image on this slide) */}
        {slide.images.length > 1 && (
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex gap-2 z-10">
            {slide.images.slice(1).map((img, idx) => (
              <img
                key={idx}
                src={img}
                alt={`Slide element ${idx + 2}`}
                className="h-16 rounded shadow-lg border border-white/20 object-cover"
              />
            ))}
          </div>
        )}

        {/* Text overlay (toggle by clicking the slide) */}
        {showText && (slide.title || slide.content) && (
          <div className="absolute inset-0 bg-black/60 flex items-end justify-center p-8 animate-fadeIn">
            <div className="max-w-4xl w-full bg-black/80 backdrop-blur-sm rounded-2xl p-6 text-white space-y-2">
              <h2 className="text-xl font-semibold">{slide.title}</h2>
              {slide.content && (
                <p className="text-sm text-white/80 leading-relaxed line-clamp-4">{slide.content}</p>
              )}
            </div>
          </div>
        )}

        {/* Slide number */}
        {slideNumber != null && totalSlides != null && (
          <div className="absolute bottom-3 right-4 px-3 py-1 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white/70 font-medium z-20">
            {slideNumber} / {totalSlides}
          </div>
        )}

        {/* Hint to toggle text */}
        {!showText && (
          <div className="absolute bottom-3 left-4 px-3 py-1 bg-black/40 backdrop-blur-sm rounded-full text-xs text-white/50 z-20">
            Click slide to show text
          </div>
        )}
      </div>
    );
  }

  // --- Text-only slide (fallback when no images were extracted) ---
  const contentLength = (slide.title + slide.content).length;
  const isLong = contentLength > 300;
  const isVeryLong = contentLength > 600;

  return (
    <div className={`
      w-full h-full relative
      flex flex-col items-center justify-center
      ${slide.bgColor}
      ${slide.textColor}
      transition-all duration-700 ease-out
    `}>
      <div className={`
        max-w-5xl w-full animate-fadeIn overflow-y-auto
        ${isVeryLong ? 'p-8 space-y-4 max-h-[85vh]' : isLong ? 'p-12 space-y-6 max-h-[85vh]' : 'p-16 space-y-12'}
      `}>
        <h1 className={`
          font-semibold tracking-tight leading-tight
          ${isVeryLong ? 'text-3xl' : isLong ? 'text-4xl' : 'text-7xl'}
        `}>
          {slide.title}
        </h1>
        {slide.content && (
          <p className={`
            font-light leading-relaxed opacity-80 whitespace-pre-line
            ${isVeryLong ? 'text-base' : isLong ? 'text-xl' : 'text-3xl'}
          `}>
            {slide.content}
          </p>
        )}
      </div>

      {slideNumber != null && totalSlides != null && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-white/10 backdrop-blur-sm rounded-full text-sm text-white/60 font-medium">
          {slideNumber} / {totalSlides}
        </div>
      )}
    </div>
  );
};
