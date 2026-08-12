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

files.forEach(file => {
  if (file === 'node_modules' || file === 'dist' || file.startsWith('.')) return;
  const ext = path.extname(file).toLowerCase();
  if (['.js', '.css', '.webmanifest', '.png', '.json', '.html'].includes(ext)) {
    const srcPath = path.join(rootDir, file);
    const destPath = path.join(distDir, file);
    try {
      if (fs.statSync(srcPath).isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (e) {
      console.warn(`Could not copy ${file}:`, e.message);
    }
  }
});

console.log('Build complete! All root scripts & assets copied to dist/.');
