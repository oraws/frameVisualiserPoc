#!/usr/bin/env node
import { chromium } from 'playwright';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const input = resolve(option('input', '/Users/stephenorawe/Work/invoice-extractor/unique_mouldings.csv'));
const outputRoot = resolve(option('output', 'source-material/mainline'));
const refresh = process.argv.includes('--refresh');

async function installedBrowser() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  for (const candidate of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Chromium.app/Contents/MacOS/Chromium']) {
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
}

function readRows(csv) {
  return csv.split(/\r?\n/).slice(1).map(line => {
    const match = line.match(/^"([^"]+)","([^"]*)"$/);
    return match ? { sku: match[1], invoiceDescription: match[2] } : null;
  }).filter(Boolean);
}

function imageDimensions(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1], length = buffer.readUInt16BE(offset + 2);
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

function safeFilename(url, index) {
  const raw = basename(new URL(url).pathname), extension = extname(raw).toLowerCase() || '.jpg';
  return `${raw.slice(0, -extension.length).replace(/[^a-z0-9_-]/gi, '-') || `img${String(index + 1).padStart(2, '0')}`}${extension}`;
}

function diagnosticHtml(manifest) {
  const frames = manifest.images.map((image, index) => `<button data-i="${index}"><img src="spin/${image.filename}" alt="${image.label}"><span>${image.label}</span></button>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${manifest.sku} supplier spin</title><style>:root{color-scheme:dark;font-family:system-ui;background:#111;color:#eee}body{margin:0;display:grid;grid-template-columns:1fr 360px}.viewer{position:sticky;top:0;height:100vh;display:grid;place-items:center;background:#181818}.viewer img{max-width:90%;max-height:90%;background:white}.rail{padding:20px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}button{padding:0;background:#222;color:#ddd;border:1px solid #444}button.active{border-color:#d8b976}button img{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:white}button span{display:block;padding:5px;font:11px monospace}</style></head><body><section class="viewer"><img id="large"></section><aside class="rail"><h1>${manifest.sku}</h1><p>${manifest.imageCount} ordered frames</p><div class="grid">${frames}</div></aside><script>const f=${JSON.stringify(manifest.images.map(({filename})=>filename))},b=[...document.querySelectorAll('button')],l=document.querySelector('#large');function s(i){l.src='spin/'+f[i];b.forEach((x,n)=>x.classList.toggle('active',n===i))}b.forEach((x,i)=>x.onclick=()=>s(i));s(0)</script></body></html>`;
}

const rows = readRows(await readFile(input, 'utf8'));
await mkdir(outputRoot, { recursive: true });
const executablePath = await installedBrowser();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
const page = await context.newPage();
await page.route('**/*', route => ['image','stylesheet','font','media'].includes(route.request().resourceType()) ? route.abort() : route.continue());
const catalogue = [];

try {
  for (const [rowIndex, row] of rows.entries()) {
    const searchUrl = `https://mainlinemouldings.com/search.php?search_query=${encodeURIComponent(row.sku)}`;
    console.log(`[${rowIndex + 1}/${rows.length}] ${row.sku}`);
    try {
      await page.goto(searchUrl, { waitUntil: 'commit', timeout: 30_000 });
      await page.waitForTimeout(3_500);
      const searchHeading = (await page.locator('h1').allTextContents()).map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean).at(-1) || '';
      if (/RESULTS? FOR/i.test(searchHeading)) {
        const candidate = await page.locator('a').evaluateAll((anchors, sku) => anchors.map(anchor => anchor.href).find(href => {
          if (!href || !href.includes('mainlinemouldings.com') || href.includes('/search.php')) return false;
          try { return new URL(href).searchParams.get('search_query')?.toUpperCase() === sku.toUpperCase(); } catch { return false; }
        }) || null, row.sku);
        if (candidate) {
          await page.goto(candidate, { waitUntil: 'commit', timeout: 30_000 });
          await page.waitForTimeout(2_500);
        }
      }
      const data = await page.evaluate(sku => {
        const clean = value => value?.replace(/\s+/g, ' ').trim() || null;
        const headings = [...document.querySelectorAll('h1')].map(node => clean(node.textContent)).filter(Boolean);
        const paragraphs = [...document.querySelectorAll('p')].map(node => clean(node.textContent)).filter(Boolean);
        const description = paragraphs.find(text => /\d+x\d+mm|Picture Frame Moulding/i.test(text)) || null;
        const spin = [...document.querySelectorAll('.basicRotate img')].map(image => ({ url: image.currentSrc || image.src || image.getAttribute('src'), width: image.naturalWidth || null, height: image.naturalHeight || null })).filter(image => image.url);
        const detailNames = [...document.querySelectorAll('.productView-info-name')].map(node => clean(node.textContent));
        const detailValues = [...document.querySelectorAll('.productView-info-value')].map(node => clean(node.textContent));
        const details = Object.fromEntries(detailNames.map((name, index) => [name?.toLowerCase(), detailValues[index] || null]));
        return {
          sku,
          name: headings.at(-1) || null,
          pageUrl: location.href,
          canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || location.href.split('?')[0],
          metaDescription: document.querySelector('meta[name="description"]')?.content || null,
          description,
          bodyText: document.body.innerText,
          discontinued: /DISCONTINUED|This item is no longer available/i.test(document.body.innerText),
          details,
          spin
        };
      }, row.sku);
      const lengthMatch = data.bodyText.match(/L:\s*([\d.]+m)/i), widthMatch = data.bodyText.match(/W:\s*([\d.]+)mm/i), depthMatch = data.bodyText.match(/H:\s*([\d.]+)mm/i), rebateMatch = data.bodyText.match(/Rebate:\s*([\d.]+)mm/i);
      const descriptionDimensions = data.description?.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/i);
      const widthMm = Number(widthMatch?.[1] || descriptionDimensions?.[1] || 0), depthMm = Number(depthMatch?.[1] || descriptionDimensions?.[2] || 0), rebateMm = Number(rebateMatch?.[1] || 0);
      const metadata = {
        sku: row.sku,
        invoiceDescription: row.invoiceDescription,
        name: data.name,
        description: data.description,
        metaDescription: data.metaDescription,
        productUrl: data.canonicalUrl,
        discoveredFrom: data.pageUrl,
        discontinued: data.discontinued,
        details: { colour: data.details.colour || null, profile: data.details.profile || null, finish: data.details.finish || null, range: data.details.range || null },
        dimensions: widthMm && depthMm ? { length: lengthMatch?.[1] || null, widthMm, depthMm, rebateMm: rebateMm || null } : null,
        spinImageCount: [...new Set(data.spin.map(image => image.url))].length,
        importedAt: new Date().toISOString()
      };
      const skuRoot = resolve(outputRoot, row.sku);
      await mkdir(skuRoot, { recursive: true });
      await writeFile(resolve(skuRoot, 'product-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);

      const existingManifest = resolve(skuRoot, 'spin-manifest.json');
      let shouldDownload = refresh;
      try { await access(existingManifest); } catch { shouldDownload = true; }
      if (shouldDownload && data.spin.length) {
        try {
          const seen = new Set(), ordered = data.spin.filter(image => !seen.has(image.url) && seen.add(image.url));
          const spinRoot = resolve(skuRoot, 'spin');
          await mkdir(spinRoot, { recursive: true });
          const images = [];
          for (const [index, image] of ordered.entries()) {
            const filename = safeFilename(image.url, index);
            let response, lastError;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                response = await context.request.get(image.url, { timeout: 30_000, headers: { referer: data.canonicalUrl } });
                if (response.ok()) break;
                lastError = new Error(`returned ${response.status()}`);
              } catch (error) { lastError = error; }
              await page.waitForTimeout(attempt * 500);
            }
            if (!response?.ok()) throw new Error(`spin ${index + 1} failed after retries: ${lastError?.message}`);
            const body = await response.body(), dimensions = imageDimensions(body);
            await writeFile(resolve(spinRoot, filename), body);
            images.push({ label: `img${String(index + 1).padStart(2, '0')}`, filename, originalUrl: image.url, width: image.width || dimensions.width, height: image.height || dimensions.height });
          }
          const manifest = { productUrl: data.canonicalUrl, sku: row.sku, imageCount: images.length, images };
          await writeFile(existingManifest, `${JSON.stringify(manifest, null, 2)}\n`);
          await writeFile(resolve(skuRoot, 'spin-diagnostic.html'), diagnosticHtml(manifest));
          metadata.spinImportStatus = 'complete';
        } catch (error) {
          metadata.spinImportStatus = 'incomplete';
          metadata.spinImportError = error.message;
          console.error(`${row.sku}: ${error.message}`);
        }
        await writeFile(resolve(skuRoot, 'product-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
      } else metadata.spinImportStatus = data.spin.length ? 'existing' : 'unavailable';
      catalogue.push(metadata);
    } catch (error) {
      console.error(`${row.sku}: ${error.message}`);
      catalogue.push({ sku: row.sku, invoiceDescription: row.invoiceDescription, status: 'not-found', error: error.message, discoveredFrom: searchUrl });
    }
  }
} finally {
  await browser.close();
}

await writeFile(resolve(outputRoot, 'invoice-catalog.json'), `${JSON.stringify({ sourceCsv: input, importedAt: new Date().toISOString(), count: catalogue.length, products: catalogue }, null, 2)}\n`);
console.log(`Wrote ${catalogue.length} catalogue records to ${resolve(outputRoot, 'invoice-catalog.json')}`);
