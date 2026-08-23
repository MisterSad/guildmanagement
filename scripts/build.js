import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log('Running Vite build...');
execSync('npx vite build', { stdio: 'inherit' });

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const files = fs.readdirSync(rootDir);
const EXCLUDED_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'vercel.json', 'vitest.config.ts'];

files.forEach(file => {
  if (file === 'node_modules' || file === 'dist' || file.startsWith('.') || EXCLUDED_FILES.includes(file)) return;
  const ext = path.extname(file).toLowerCase();
  if (['.js', '.css', '.webmanifest', '.png', '.json', '.html'].includes(ext)) {
    const srcPath = path.join(rootDir, file);
    const destPath = path.join(distDir, file);
    try {
      if (fs.statSync(srcPath).isFile()) {
        if (ext === '.js') {
          try {
            execSync(`node --check "${srcPath}"`, { stdio: 'pipe' });
          } catch (syntaxErr) {
            console.error(`\n❌ BUILD FAILED: SyntaxError in ${file}`);
            throw new Error(`Syntax check failed for ${file}: ${syntaxErr.message}`);
          }
        }
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (e) {
      if (e.message && e.message.startsWith('Syntax check failed')) {
        throw e;
      }
      console.warn(`Could not copy ${file}:`, e.message);
    }
  }
});

console.log('Build complete! All root scripts & assets copied to dist/.');
