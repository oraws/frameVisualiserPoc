import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packRoot = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(packRoot, 'reference-images', 'current-comparison');
const visualiserUrl = process.env.VISUALISER_URL || 'http://127.0.0.1:4321/';

await mkdir(outputDir, { recursive: true });

// A headed browser is intentional: Three.js/WebGL is unavailable in the
// sandboxed Chromium headless shell on macOS, so it never creates the canvas.
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

await page.goto(visualiserUrl, { waitUntil: 'networkidle' });
await page.locator('canvas').waitFor({ state: 'visible' });
await page.getByRole('button', { name: 'Frame detail', exact: true }).click();
await page.getByRole('button', { name: 'Slight Angle', exact: true }).click();
await page.getByRole('button', { name: 'Texture', exact: true }).click();

async function capture(sku, variant, filename) {
  await page.locator('select').first().selectOption(sku);
  await page.getByRole('button', { name: variant, exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: false });
}

await capture('POL-4508', 'Current', 'POL-4508-current-tuned.png');
await capture('POL-4508', 'SAM 2.1', 'POL-4508-SAM2-experimental.png');
await capture('POL-4875', 'Current', 'POL-4875-current-tuned.png');
await capture('POL-4875', 'SAM 2.1', 'POL-4875-SAM2-experimental.png');

await browser.close();

if (pageErrors.length) {
  throw new Error(`Visualiser page errors:\n${pageErrors.join('\n')}`);
}

console.log(`Captured four comparison renders in ${outputDir}`);
