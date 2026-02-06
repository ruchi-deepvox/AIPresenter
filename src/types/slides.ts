export interface Slide {
  id: number;
  title: string;
  content: string;
  bgColor: string;
  textColor: string;
  notes?: string;
  /** Blob URLs of images extracted from this slide */
  images: string[];
}
