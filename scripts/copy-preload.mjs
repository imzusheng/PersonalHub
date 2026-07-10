import { mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src', 'desktop', 'preload');
const dstDir = join(__dirname, '..', 'dist', 'desktop', 'preload');

mkdirSync(dstDir, { recursive: true });

for (const f of readdirSync(srcDir)) {
  const src = join(srcDir, f);
  if (statSync(src).isFile() && f.endsWith('.cjs')) {
    copyFileSync(src, join(dstDir, f));
    console.log('copied', f);
  }
}
