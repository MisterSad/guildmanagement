/**
 * tests/image_compressor.test.ts
 *
 * Unit tests for client-side image compression utility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateTargetDimensions,
  compressImage,
  extractImagesFromClipboard,
  extractImagesFromDrop
} from '../src/core/utils/image-compressor';

describe('image-compressor', () => {
  describe('calculateTargetDimensions', () => {
    it('returns original dimensions if already within max bounds', () => {
      const res = calculateTargetDimensions(800, 600, 1440, 1440);
      expect(res).toEqual({ width: 800, height: 600 });
    });

    it('scales down proportionally when width exceeds maxWidth', () => {
      const res = calculateTargetDimensions(2880, 1440, 1440, 1440);
      expect(res).toEqual({ width: 1440, height: 720 });
    });

    it('scales down proportionally when height exceeds maxHeight', () => {
      const res = calculateTargetDimensions(1000, 2000, 1440, 1000);
      expect(res).toEqual({ width: 500, height: 1000 });
    });

    it('handles zero or negative dimensions safely', () => {
      const res = calculateTargetDimensions(0, 0, 1440, 1440);
      expect(res.width).toBeGreaterThan(0);
      expect(res.height).toBeGreaterThan(0);
    });
  });

  describe('extractImagesFromClipboard', () => {
    it('extracts image files from clipboard data items', () => {
      const dummyFile = new File(['dummy'], 'screen.png', { type: 'image/png' });
      const mockEvent = {
        clipboardData: {
          items: [
            { type: 'text/plain', getAsFile: () => null },
            { type: 'image/png', getAsFile: () => dummyFile }
          ]
        }
      } as unknown as ClipboardEvent;

      const extracted = extractImagesFromClipboard(mockEvent);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].name).toBe('screen.png');
    });

    it('returns empty array when no clipboard data is present', () => {
      const mockEvent = {} as ClipboardEvent;
      expect(extractImagesFromClipboard(mockEvent)).toEqual([]);
    });
  });

  describe('extractImagesFromDrop', () => {
    it('extracts image files from drag event dataTransfer', () => {
      const dummyFile = new File(['dummy'], 'screen.jpg', { type: 'image/jpeg' });
      const textFile = new File(['text'], 'doc.txt', { type: 'text/plain' });
      const mockEvent = {
        dataTransfer: {
          files: [dummyFile, textFile]
        }
      } as unknown as DragEvent;

      const extracted = extractImagesFromDrop(mockEvent);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].name).toBe('screen.jpg');
    });

    it('returns empty array when no files in dataTransfer', () => {
      const mockEvent = {} as DragEvent;
      expect(extractImagesFromDrop(mockEvent)).toEqual([]);
    });
  });
});
