import { useState, useRef, useCallback } from 'react';
import { Sparkles, Upload, FileText, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Slide } from '../types/slides';
import { parsePptxText } from '../utils/parsePptx';
import { parsePdf } from '../utils/parsePdf';

interface WelcomeModalProps {
  onStart: (slides: Slide[]) => void;
}

export const WelcomeModal = ({ onStart }: WelcomeModalProps) => {
  const [parsedSlides, setParsedSlides] = useState<Slide[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith('.pdf');
    const isPptx = lower.endsWith('.pptx');

    if (!isPdf && !isPptx) {
      setError('Please upload a .pptx (PowerPoint) or .pdf file.');
      setParsedSlides(null);
      return;
    }

    setError('');
    setFileName(file.name);
    setIsParsing(true);
    setParsedSlides(null);

    try {
      if (isPdf) {
        setStatus('Processing PDF pages...');
        const slides = await parsePdf(file);
        if (slides.length === 0) throw new Error('No pages found in the PDF.');
        setStatus('');
        setParsedSlides(slides);
        return;
      }

      // PPTX flow
      setStatus('Extracting text from slides...');
      const textSlides = await parsePptxText(file);

      if (textSlides.length === 0) {
        throw new Error('No slides found in the file.');
      }

      setStatus('Converting slides to images (via PowerPoint)...');
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.success || !data.images || data.images.length === 0) {
        throw new Error('No slide images returned from server.');
      }

      const mergedSlides: Slide[] = textSlides.map((slide, i) => ({
        ...slide,
        images: data.images[i] ? [data.images[i]] : [],
      }));

      for (let i = textSlides.length; i < data.images.length; i++) {
        mergedSlides.push({
          id: i + 1,
          title: `Slide ${i + 1}`,
          content: '',
          bgColor: 'bg-black',
          textColor: 'text-white',
          images: [data.images[i]],
        });
      }

      setStatus('');
      setParsedSlides(mergedSlides);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to process the file.';
      setError(msg);
      setStatus('');
      setParsedSlides(null);
    } finally {
      setIsParsing(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleStart = () => {
    if (parsedSlides && parsedSlides.length > 0) {
      onStart(parsedSlides);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-white rounded-3xl shadow-2xl p-10 max-w-2xl w-full mx-4 transform transition-all">
        <div className="flex flex-col items-center text-center space-y-6">
          <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-cyan-500 rounded-full flex items-center justify-center">
            <Sparkles className="w-8 h-8 text-white" strokeWidth={2} />
          </div>

          <div className="space-y-2">
            <h1 className="text-4xl font-semibold tracking-tight text-slate-900">
              AI Presenter
            </h1>
            <p className="text-lg text-slate-500 font-light">
              Upload your PowerPoint or PDF and let AI present it
            </p>
          </div>

          {/* Upload area */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !isParsing && fileInputRef.current?.click()}
            className={`
              w-full border-2 border-dashed rounded-2xl p-8 transition-all duration-200
              ${isParsing ? 'cursor-wait' : 'cursor-pointer'}
              ${isDragOver
                ? 'border-blue-500 bg-blue-50 scale-[1.02]'
                : parsedSlides
                ? 'border-emerald-300 bg-emerald-50'
                : 'border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/50'
              }
            `}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pptx,.pdf"
              onChange={handleInputChange}
              className="hidden"
            />

            {isParsing ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
                <p className="text-slate-600 font-medium">{status || 'Processing...'}</p>
                <p className="text-xs text-slate-400">This may take a moment for large files</p>
              </div>
            ) : parsedSlides ? (
              <div className="flex flex-col items-center gap-3">
                <CheckCircle className="w-10 h-10 text-emerald-500" />
                <div>
                  <p className="text-slate-800 font-medium">{fileName}</p>
                  <p className="text-emerald-600 text-sm mt-1">
                    {parsedSlides.length} slide{parsedSlides.length !== 1 ? 's' : ''} ready
                  </p>
                </div>
                <p className="text-xs text-slate-400 mt-1">Click to upload a different file</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 bg-slate-200 rounded-xl flex items-center justify-center">
                  <Upload className="w-6 h-6 text-slate-500" />
                </div>
                <div>
                  <p className="text-slate-700 font-medium">
                    Drop your <span className="text-blue-600">.pptx</span> or <span className="text-blue-600">.pdf</span> file here
                  </p>
                  <p className="text-slate-400 text-sm mt-1">or click to browse</p>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 text-red-600 text-sm bg-red-50 px-4 py-3 rounded-lg w-full text-left">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Slide preview thumbnails */}
          {parsedSlides && parsedSlides.length > 0 && (
            <div className="w-full">
              <div className="flex gap-2 overflow-x-auto py-2 px-1">
                {parsedSlides.map((slide, i) => (
                  <div
                    key={slide.id}
                    className="flex-shrink-0 w-24 h-14 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 relative"
                  >
                    {slide.images.length > 0 ? (
                      <img
                        src={slide.images[0]}
                        alt={slide.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <FileText className="w-4 h-4 text-slate-400" />
                      </div>
                    )}
                    <div className="absolute bottom-0 right-0 px-1 bg-black/50 text-white text-[9px] rounded-tl">
                      {i + 1}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={handleStart}
            disabled={!parsedSlides || parsedSlides.length === 0}
            className={`
              group relative px-8 py-4 text-lg font-medium rounded-full shadow-lg
              transition-all duration-300
              ${parsedSlides
                ? 'bg-gradient-to-r from-blue-600 to-cyan-600 text-white hover:shadow-xl hover:scale-105 active:scale-95'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }
            `}
          >
            <span className="relative z-10">
              {parsedSlides ? 'Start AI Presentation' : 'Upload a PPTX or PDF to begin'}
            </span>
            {parsedSlides && (
              <div className="absolute inset-0 rounded-full bg-gradient-to-r from-blue-700 to-cyan-700 opacity-0 group-hover:opacity-100 transition-opacity" />
            )}
          </button>

          <p className="text-xs text-slate-400">
            PPTX requires Microsoft PowerPoint for rendering &middot; PDF works in-browser
          </p>
        </div>
      </div>
    </div>
  );
};
