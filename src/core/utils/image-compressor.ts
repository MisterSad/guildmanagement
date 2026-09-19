/**
 * src/core/utils/image-compressor.ts
 *
 * High-performance client-side image compression utility using HTML5 Canvas.
 * Automatically downscales large game screenshots and compresses them to
 * WebP / JPEG to reduce payload size by 80-90% before uploading to Supabase.
 */

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  preferredMimeType?: 'image/webp' | 'image/jpeg';
}

export interface CompressedImageResult {
  dataUrl: string;
  sizeBytes: number;
  width: number;
  height: number;
  mimeType: string;
}

const DEFAULT_OPTIONS: Required<CompressionOptions> = {
  maxWidth: 1440,
  maxHeight: 1440,
  quality: 0.78,
  preferredMimeType: 'image/webp'
};

/**
 * Calculates proportionally scaled dimensions fitting within maxWidth x maxHeight.
 */
export function calculateTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (srcWidth <= 0 || srcHeight <= 0) {
    return { width: Math.max(1, maxWidth), height: Math.max(1, maxHeight) };
  }

  let width = srcWidth;
  let height = srcHeight;

  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }

  if (height > maxHeight) {
    width = Math.round((width * maxHeight) / height);
    height = maxHeight;
  }

  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Compresses an image File or Blob in the browser using HTML5 Canvas.
 */
export async function compressImage(
  fileOrBlob: File | Blob,
  options?: CompressionOptions
): Promise<CompressedImageResult> {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };

  // Read blob into an HTMLImageElement
  const dataUrlOriginal = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(fileOrBlob);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load image into DOM'));
    image.src = dataUrlOriginal;
  });

  const { width: targetWidth, height: targetHeight } = calculateTargetDimensions(
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
    opts.maxWidth,
    opts.maxHeight
  );

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is not available');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Fill white background for JPEG fallback in case of transparency
  if (opts.preferredMimeType === 'image/jpeg') {
    ctx.fillStyle = '#1A1D24';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
  }

  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // Attempt WebP first, fallback to JPEG if browser doesn't support WebP export
  let mime = opts.preferredMimeType;
  let compressedDataUrl = canvas.toDataURL(mime, opts.quality);

  if (mime === 'image/webp' && !compressedDataUrl.startsWith('data:image/webp')) {
    mime = 'image/jpeg';
    compressedDataUrl = canvas.toDataURL(mime, opts.quality);
  }

  // Calculate approximate byte size from base64 string
  const base64Data = compressedDataUrl.split(',')[1] || '';
  const sizeBytes = Math.round((base64Data.length * 3) / 4);

  return {
    dataUrl: compressedDataUrl,
    sizeBytes,
    width: targetWidth,
    height: targetHeight,
    mimeType: mime
  };
}

/**
 * Extracts image files from a paste event (Ctrl+V / Cmd+V).
 */
export function extractImagesFromClipboard(event: ClipboardEvent): File[] {
  const files: File[] = [];
  const items = event.clipboardData?.items;
  if (!items) return files;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/**
 * Extracts image files from a drag & drop event.
 */
export function extractImagesFromDrop(event: DragEvent): File[] {
  const files: File[] = [];
  const dt = event.dataTransfer;
  if (!dt || !dt.files) return files;

  for (let i = 0; i < dt.files.length; i++) {
    const file = dt.files[i];
    if (file.type.startsWith('image/')) {
      files.push(file);
    }
  }
  return files;
}
