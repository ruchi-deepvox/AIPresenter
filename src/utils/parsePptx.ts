import JSZip from 'jszip';
import { Slide } from '../types/slides';

/**
 * Extract text grouped by shape/text frame from a slide XML.
 * Returns an array of strings, one per text frame (shape).
 */
function extractTextFrames(xmlDoc: Document): string[] {
  const frames: string[] = [];
  const allElements = xmlDoc.getElementsByTagName('*');

  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    if (
      el.localName === 'txBody' ||
      (el.localName === 'sp' && el.tagName.startsWith('p:'))
    ) {
      const innerTexts: string[] = [];
      const children = el.getElementsByTagName('*');
      for (let j = 0; j < children.length; j++) {
        const child = children[j];
        if (
          child.localName === 't' &&
          (child.namespaceURI?.includes('drawingml') ||
            child.tagName === 'a:t' ||
            child.tagName.endsWith(':t'))
        ) {
          const t = child.textContent?.trim();
          if (t) innerTexts.push(t);
        }
      }
      if (innerTexts.length > 0) {
        frames.push(innerTexts.join(' '));
      }
    }
  }

  // Deduplicate (txBody is inside sp, so we might get doubles)
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const f of frames) {
    if (!seen.has(f)) {
      seen.add(f);
      unique.push(f);
    }
  }

  return unique;
}

/**
 * Extract notes text from a notes slide XML.
 */
function extractNotes(xmlDoc: Document): string {
  const texts: string[] = [];
  const allElements = xmlDoc.getElementsByTagName('*');
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    if (
      el.localName === 't' &&
      (el.namespaceURI?.includes('drawingml') ||
        el.tagName === 'a:t' ||
        el.tagName.endsWith(':t'))
    ) {
      const t = el.textContent?.trim();
      if (t) texts.push(t);
    }
  }
  return texts.join(' ').trim();
}

/**
 * Get sorted slide file names from the ZIP.
 */
function getSlideFiles(zip: JSZip): string[] {
  const slideFiles: string[] = [];
  zip.forEach((relativePath) => {
    const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) {
      slideFiles.push(relativePath);
    }
  });

  slideFiles.sort((a, b) => {
    const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0', 10);
    const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0', 10);
    return numA - numB;
  });

  return slideFiles;
}

/**
 * Parse a PPTX file client-side to extract text content from each slide.
 * This is used for AI narration; images are handled by the server.
 * Returns Slide[] with text but no images (images field is empty).
 */
export async function parsePptxText(file: File): Promise<Slide[]> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const slideFiles = getSlideFiles(zip);

  if (slideFiles.length === 0) {
    throw new Error('No slides found in the PPTX file.');
  }

  const slides: Slide[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const slideFile = slideFiles[i];
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)?.[1] || '0', 10);

    // Parse slide XML
    const xmlString = await zip.file(slideFile)!.async('text');
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'application/xml');

    // Extract text
    const textFrames = extractTextFrames(xmlDoc);
    let title = '';
    let content = '';

    if (textFrames.length === 0) {
      title = `Slide ${slideNum}`;
      content = '';
    } else if (textFrames.length === 1) {
      title = textFrames[0];
      content = '';
    } else {
      title = textFrames[0];
      content = textFrames.slice(1).join('. ');
    }

    // Try to extract notes
    let notes = '';
    const notesFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    if (zip.file(notesFile)) {
      try {
        const notesXml = await zip.file(notesFile)!.async('text');
        const notesDoc = parser.parseFromString(notesXml, 'application/xml');
        notes = extractNotes(notesDoc);
      } catch {
        // No notes
      }
    }

    slides.push({
      id: slideNum,
      title: title || `Slide ${slideNum}`,
      content,
      bgColor: 'bg-black',
      textColor: 'text-white',
      notes: notes || undefined,
      images: [], // Images will be filled in by the server conversion
    });
  }

  return slides;
}
