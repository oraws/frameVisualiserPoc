#!/usr/bin/env node
import { chromium } from 'playwright';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const productUrl = option('url');
const sku = option('sku');
const outputRoot = resolve(option('output', sku ? `source-material/mainline/${sku}` : ''));
if (!productUrl || !sku) {
  throw new Error('Usage: npm run spin:mainline -- --url <product-url> --sku <SKU>');
}

async function installedBrowser() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try the next browser */ }
  }
  return undefined;
}

function safeFilename(url, index) {
  const raw = basename(new URL(url).pathname);
  const extension = extname(raw).toLowerCase() || '.jpg';
  const stem = raw.slice(0, raw.length - extension.length).replace(/[^a-z0-9_-]/gi, '-');
  return `${stem || `img${String(index + 1).padStart(2, '0')}`}${extension}`;
}

function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

function diagnosticHtml(manifest) {
  const cards = manifest.images.map((image, index) => `
    <button class="thumb" data-index="${index}" type="button">
      <img src="spin/${encodeURIComponent(image.filename)}" alt="${image.label}" loading="lazy">
      <span>${image.label}</span>
    </button>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${manifest.sku} spin inspection</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#111;color:#eee}*{box-sizing:border-box}body{margin:0}.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;min-height:100vh}.viewer{position:sticky;top:0;height:100vh;display:grid;place-items:center;padding:32px;background:#181818}.viewer img{max-width:100%;max-height:calc(100vh - 100px);object-fit:contain;background:#fff}.caption{position:absolute;left:40px;bottom:25px;font:13px ui-monospace,monospace;color:#bbb}.rail{padding:24px;border-left:1px solid #333;background:#101010}.rail h1{font-size:21px;margin:0 0 6px}.rail p{color:#999;margin:0 0 20px;font-size:13px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.thumb{padding:0;border:1px solid #333;background:#1d1d1d;color:#ccc;cursor:pointer}.thumb.active{border-color:#d5ad66}.thumb img{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:#fff}.thumb span{display:block;padding:6px;font:11px ui-monospace,monospace}</style></head>
<body><main class="layout"><section class="viewer"><img id="large" alt="Selected spin frame"><div class="caption" id="caption"></div></section><aside class="rail"><h1>${manifest.sku}</h1><p>${manifest.imageCount} ordered spin frames</p><div class="grid">${cards}</div></aside></main>
<script>const frames=${JSON.stringify(manifest.images.map(({filename,label,width,height})=>({filename,label,width,height})))};const large=document.querySelector('#large');const caption=document.querySelector('#caption');const buttons=[...document.querySelectorAll('.thumb')];function select(i){const f=frames[i];large.src='spin/'+encodeURIComponent(f.filename);caption.textContent=f.label+' · '+(f.width||'?')+' × '+(f.height||'?')+' px';buttons.forEach((b,n)=>b.classList.toggle('active',n===i))}buttons.forEach((b,i)=>b.addEventListener('click',()=>select(i)));select(0)</script></body></html>`;
}

const executablePath = await installedBrowser();
console.log(`Launching ${executablePath || 'Playwright Chromium'} for ${productUrl}`);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  await page.route('**/*', route => {
    const resourceType = route.request().resourceType();
    return ['image', 'stylesheet', 'font', 'media'].includes(resourceType) ? route.abort() : route.continue();
  });
  console.log('Loading product page…');
  await page.goto(productUrl, { waitUntil: 'commit', timeout: 30_000 });
  console.log(`Loaded ${page.url()}; waiting for .basicRotate…`);
  await page.waitForSelector('.basicRotate', { state: 'attached', timeout: 30_000 });
  console.log('Found .basicRotate; extracting ordered image sources…');
  await page.locator('.basicRotate').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_000);
  const extracted = await page.locator('.basicRotate img').evaluateAll(images =>
    images.map(image => ({
      url: image.currentSrc || image.src || image.getAttribute('src') || '',
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined
    }))
  );
  const seen = new Set();
  const ordered = extracted.filter(image => image.url && !seen.has(image.url) && seen.add(image.url));
  if (!ordered.length) throw new Error(`.basicRotate was found, but it contained no downloadable img sources at ${productUrl}`);
  console.log(`Found ${ordered.length} unique spin images; downloading originals…`);

  const spinDirectory = resolve(outputRoot, 'spin');
  await mkdir(spinDirectory, { recursive: true });
  const images = await Promise.all(ordered.map(async (image, index) => {
    const filename = safeFilename(image.url, index);
    const response = await context.request.get(image.url, { timeout: 30_000, headers: { referer: productUrl } });
    if (!response.ok()) throw new Error(`Image ${index + 1} failed (${response.status()}): ${image.url}`);
    const body = await response.body();
    await writeFile(resolve(spinDirectory, filename), body);
    const dimensions = imageDimensions(body);
    return { label: `img${String(index + 1).padStart(2, '0')}`, filename, originalUrl: image.url, width: image.width ?? dimensions.width, height: image.height ?? dimensions.height };
  }));
  const manifest = { productUrl, sku, imageCount: images.length, images };
  await writeFile(resolve(outputRoot, 'spin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(outputRoot, 'spin-diagnostic.html'), diagnosticHtml(manifest));
  console.log(`Imported ${images.length} ordered images for ${sku} to ${spinDirectory}`);
  console.log(`Diagnostic: ${resolve(outputRoot, 'spin-diagnostic.html')}`);
} finally {
  await browser.close();
}
