import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { Slide } from '../types/slides';

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

/**
 * Extract text from a page's TextContent for AI narration.
 */
function textContentToString(items: { str?: string }[]): string {
  return items.map((item) => item.str || '').join(' ').trim();
}

/**
 * Parse a PDF file client-side: extract text and render each page to an image.
 * Returns Slide[] with both text (for AI) and image blob URLs (for display).
 */
export async function parsePdf(file: File): Promise<Slide[]> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;

  if (numPages === 0) {
    throw new Error('No pages found in the PDF.');
  }

  const scale = 2;
  const slides: Slide[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context.');

    await page.render({
      canvasContext: ctx,
      viewport,
      intent: 'display',
    }).promise;

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        'image/png',
        0.95
      );
    });
    const imageUrl = URL.createObjectURL(blob);

    let title = `Slide ${i}`;
    let content = '';

    try {
      const textContent = await page.getTextContent();
      const fullText = textContentToString(textContent.items);
      if (fullText) {
        const lines = fullText.split(/\s{2,}|\n+/).filter(Boolean);
        if (lines.length >= 1) {
          title = lines[0].slice(0, 100);
          content = lines.slice(1).join(' ').slice(0, 500);
        } else {
          content = fullText.slice(0, 500);
        }
      }
    } catch {
      // Keep default title/content
    }

    slides.push({
      id: i,
      title: title || `Slide ${i}`,
      content,
      bgColor: 'bg-white',
      textColor: 'text-slate-900',
      images: [imageUrl],
    });
  }

  return slides;
}
