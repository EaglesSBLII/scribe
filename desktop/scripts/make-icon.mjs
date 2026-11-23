// Turns resources/icons/icon.svg into the Mac app icon (icon.icns) and the web
// app's icon. Uses Playwright's browser to draw the SVG, then the Mac's own
// sips and iconutil tools. Run with: node desktop/scripts/make-icon.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const icons = path.resolve(import.meta.dirname, '../resources/icons');
const svg = fs.readFileSync(path.join(icons, 'icon.svg'), 'utf8');
const png = path.join(icons, 'icon.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
await page.screenshot({ path: png, omitBackground: true });
await browser.close();

const set = path.join(icons, 'icon.iconset');
fs.mkdirSync(set, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(icons, 'icon.icns')]);
fs.copyFileSync(path.join(icons, 'icon.svg'), path.resolve(import.meta.dirname, '../../app/public/icon.svg'));
console.log('Wrote icon.png, icon.icns and app/public/icon.svg');
