import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const mainTsPath = path.resolve(__dirname, '../src/main.ts');
const indexHtmlPath = path.resolve(__dirname, '../index.html');
const buildJsPath = path.resolve(__dirname, '../scripts/build.js');

describe('TICKET-07 [PERF-02]: Unified CSS Bundling in Vite', () => {
  it('verifies that src/main.ts imports all 5 CSS files in proper cascade order', () => {
    expect(fs.existsSync(mainTsPath)).toBe(true);
    const mainTs = fs.readFileSync(mainTsPath, 'utf8');

    const expectedOrder = [
      "import '../tokens.css';",
      "import '../theme.css';",
      "import '../styles.css';",
      "import '../components.css';",
      "import '../shell.css';",
    ];

    let lastIndex = -1;
    for (const statement of expectedOrder) {
      const idx = mainTs.indexOf(statement);
      expect(idx, `Expected src/main.ts to contain ${statement}`).toBeGreaterThan(-1);
      expect(idx, `${statement} should appear in proper cascade order`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('verifies that index.html no longer has manual link tags for the 5 CSS files', () => {
    expect(fs.existsSync(indexHtmlPath)).toBe(true);
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    expect(indexHtml).not.toContain('href="tokens.css');
    expect(indexHtml).not.toContain('href="theme.css');
    expect(indexHtml).not.toContain('href="styles.css');
    expect(indexHtml).not.toContain('href="components.css');
    expect(indexHtml).not.toContain('href="shell.css');
  });

  it('verifies that scripts/build.js excludes the 5 CSS files from root dist copy', () => {
    expect(fs.existsSync(buildJsPath)).toBe(true);
    const buildJs = fs.readFileSync(buildJsPath, 'utf8');

    const cssFiles = ['tokens.css', 'theme.css', 'styles.css', 'components.css', 'shell.css'];
    for (const f of cssFiles) {
      expect(buildJs).toContain(`'${f}'`);
    }
  });
});
