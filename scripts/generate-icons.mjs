import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, '..', 'build');
const pngPath = join(buildDir, 'icon.png');

if (!existsSync(pngPath)) {
  console.error('SKIP: build/icon.png not found. Place a 1024x1024 PNG there first.');
  process.exit(0);
}

const pngData = readFileSync(pngPath);

function getPngDimensions(data) {
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return { width, height };
}

function generateIco() {
  const icoPath = join(buildDir, 'icon.ico');
  const { width, height } = getPngDimensions(pngData);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const w = width > 256 ? 0 : width;
  const h = height > 256 ? 0 : height;

  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(w, 0);
  dirEntry.writeUInt8(h, 1);
  dirEntry.writeUInt8(0, 2);
  dirEntry.writeUInt8(0, 3);
  dirEntry.writeUInt16LE(0, 4);
  dirEntry.writeUInt16LE(32, 6);
  dirEntry.writeUInt32LE(pngData.length, 8);
  dirEntry.writeUInt32LE(22, 12);

  writeFileSync(icoPath, Buffer.concat([header, dirEntry, pngData]));
  console.log(`Generated: ${icoPath}`);
}

async function generateIcns() {
  if (process.platform !== 'darwin') {
    console.log('Skipping .icns generation (requires macOS)');
    return;
  }

  const icnsPath = join(buildDir, 'icon.icns');
  const iconset = join(buildDir, 'icon.iconset');

  const { execSync } = await import('node:child_process');

  mkdirSync(iconset, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512];
  for (const size of sizes) {
    const doubleSize = size * 2;
    execSync(
      `sips -z ${size} ${size} "${pngPath}" --out "${join(iconset, `icon_${size}x${size}.png`)}"`,
      { stdio: 'inherit' },
    );
    if (doubleSize <= 1024) {
      execSync(
        `sips -z ${doubleSize} ${doubleSize} "${pngPath}" --out "${join(iconset, `icon_${size}x${size}@2x.png`)}"`,
        { stdio: 'inherit' },
      );
    }
  }

  execSync(`iconutil -c icns "${iconset}" -o "${icnsPath}"`, { stdio: 'inherit' });
  console.log(`Generated: ${icnsPath}`);
}

generateIco();
await generateIcns();
