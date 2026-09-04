import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function getPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`File is not a valid PNG: ${filePath}`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('PWA & Application Icon Assets', () => {
  const rootDir = path.resolve(__dirname, '..');

  it('all required icon assets exist with non-zero size', () => {
    const requiredFiles = [
      'favicon.ico',
      'favicon.png',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-192-maskable.png',
      'icon-512.png',
      'icon-512-maskable.png',
      'manifest.webmanifest',
    ];

    for (const relPath of requiredFiles) {
      const fullPath = path.join(rootDir, relPath);
      expect(fs.existsSync(fullPath), `Missing icon asset: ${relPath}`).toBe(true);
      const stat = fs.statSync(fullPath);
      expect(stat.size, `Empty icon asset: ${relPath}`).toBeGreaterThan(100);
    }
  });

  it('PNG icons match strict platform dimensional specifications', () => {
    const specs = [
      { file: 'favicon.png', width: 32, height: 32 },
      { file: 'apple-touch-icon.png', width: 180, height: 180 },
      { file: 'icon-192.png', width: 192, height: 192 },
      { file: 'icon-192-maskable.png', width: 192, height: 192 },
      { file: 'icon-512.png', width: 512, height: 512 },
      { file: 'icon-512-maskable.png', width: 512, height: 512 },
    ];

    for (const { file, width, height } of specs) {
      const fullPath = path.join(rootDir, file);
      const dims = getPngDimensions(fullPath);
      expect(dims.width, `${file} width`).toBe(width);
      expect(dims.height, `${file} height`).toBe(height);
    }
  });

  it('manifest.webmanifest specifies any and maskable icons', () => {
    const manifestPath = path.join(rootDir, 'manifest.webmanifest');
    const content = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    expect(content.icons).toBeDefined();
    expect(content.icons.length).toBeGreaterThanOrEqual(4);

    const purposes = content.icons.map(i => i.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');

    const srcFiles = content.icons.map(i => i.src.split('?')[0]);
    expect(srcFiles).toContain('icon-192.png');
    expect(srcFiles).toContain('icon-512.png');
    expect(srcFiles).toContain('icon-192-maskable.png');
    expect(srcFiles).toContain('icon-512-maskable.png');
  });

  it('index.html links favicon, apple-touch-icon, and manifest with cache busters', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');

    expect(html).toContain('rel="icon" type="image/x-icon" href="favicon.ico?v=3"');
    expect(html).toContain('rel="icon" type="image/png" sizes="32x32" href="favicon.png?v=3"');
    expect(html).toContain('rel="apple-touch-icon" href="apple-touch-icon.png?v=3"');
    expect(html).toContain('rel="manifest" href="manifest.webmanifest?v=3"');
  });

  it('terms.html links favicon and apple-touch-icon with matching cache busters', () => {
    const html = fs.readFileSync(path.join(rootDir, 'terms.html'), 'utf-8');

    expect(html).toContain('rel="icon" type="image/x-icon" href="favicon.ico?v=3"');
    expect(html).toContain('rel="icon" type="image/png" sizes="32x32" href="favicon.png?v=3"');
    expect(html).toContain('rel="apple-touch-icon" href="apple-touch-icon.png?v=3"');
    expect(html).toContain('rel="manifest" href="manifest.webmanifest?v=3"');
  });
});
