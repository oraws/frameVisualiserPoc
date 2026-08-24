#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || 'source-material/mainline');
const sources = [
  {
    sku: 'POL-4100', name: 'Brushed Black 41mm Polcore Moulding',
    json: 'POL-4100/profile-analysis/simple-auto/profile-candidate.json',
    diagnostic: 'POL-4100/profile-analysis/simple-auto/profile-review.html',
    preview: 'POL-4100/profile-analysis/simple-auto/img23-silhouette-overlay.png',
  },
  {
    sku: 'POL-4875', name: 'Verona Black 97mm Polcore Moulding',
    json: 'POL-4875/profile-analysis/auto/profile-auto.json',
    diagnostic: 'POL-4875/profile-analysis/gemma/profile-inspect.html',
    preview: 'POL-4875/profile-analysis/auto/profile-comparison.png',
  },
];

const records = [];
for (const source of sources) {
  const profile = JSON.parse(await readFile(resolve(root, source.json), 'utf8'));
  records.push({ ...source, profile, eligible: profile.autoRouteEligible === true });
}

const cards = records.map((record) => `<article class="card" data-sku="${record.sku}">
  <img src="${record.preview}" alt="${record.sku} extraction preview">
  <div class="copy"><div class="eyebrow">${record.sku}</div><h2>${record.name}</h2>
  <p>${record.eligible ? 'Simple-profile route passed the conservative threshold.' : 'Compare the deterministic trace with the new local Gemma candidate, or leave Verona for manual tracing.'}</p>
  <dl><div><dt>Confidence</dt><dd>${Number(record.profile.confidence).toFixed(3)}</dd></div><div><dt>Route</dt><dd>${record.eligible ? 'Auto eligible' : 'Fine tuning'}</dd></div></dl>
  <div class="actions">${record.eligible ? '<button class="accept">Accept auto route</button>' : ''}<button class="tune">Queue for fine tuning</button><a href="${record.diagnostic}">Inspect</a><a href="${record.sku}/profile-analysis/manual/manual-trace.html">Trace manually</a></div><p class="status"></p></div></article>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mainline profile review queue</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}*{box-sizing:border-box}body{max-width:1240px;margin:auto;padding:36px}header{max-width:760px;margin-bottom:30px}.eyebrow{font:12px ui-monospace,monospace;letter-spacing:.16em;color:#d8b36d}h1{font-size:38px;margin:8px 0}p{color:#aaa;line-height:1.55}.queue{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:#1a1a1a;border:1px solid #303030}.card img{display:block;width:100%;height:340px;object-fit:contain;background:#eee}.copy{padding:20px}.copy h2{margin:6px 0 8px}dl{display:flex;gap:28px;border-top:1px solid #333;border-bottom:1px solid #333;padding:14px 0}dl div{display:grid;gap:3px}dt{font-size:11px;text-transform:uppercase;color:#777}dd{margin:0}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}button,a{border:1px solid #555;background:#222;color:#eee;padding:11px 14px;text-decoration:none;cursor:pointer;font-weight:650}.accept{background:#d8b36d;color:#17130c;border-color:#d8b36d}.status{min-height:22px;color:#a8d9b0;margin-bottom:0}@media(max-width:800px){.queue{grid-template-columns:1fr}.card img{height:260px}}</style></head><body>
<header><div class="eyebrow">EXPERIMENTAL PROFILE INTAKE</div><h1>Review automatic routes</h1><p>Approve reliable simple profiles or queue a moulding for the later manual trace editor. No decision on this page changes the Three.js renderer.</p></header><main class="queue">${cards}</main>
<script>const records=${JSON.stringify(records.map(({sku,name,profile,eligible})=>({sku,name,profile,eligible})))};function download(record,status){const decision={sku:record.sku,name:record.name,status,profile:status==='approved-auto'?record.profile:null,createdAt:new Date().toISOString()};const blob=new Blob([JSON.stringify(decision,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=record.sku+'-'+status+'.json';a.click();URL.revokeObjectURL(a.href);try{localStorage.setItem('mainline-profile-decision:'+record.sku,JSON.stringify(decision))}catch{}return status==='approved-auto'?'Auto route accepted; decision JSON downloaded.':'Queued for manual fine tuning; queue JSON downloaded.'}document.querySelectorAll('.card').forEach(card=>{const record=records.find(item=>item.sku===card.dataset.sku);card.querySelector('.accept')?.addEventListener('click',()=>card.querySelector('.status').textContent=download(record,'approved-auto'));card.querySelector('.tune').addEventListener('click',()=>card.querySelector('.status').textContent=download(record,'fine-tuning-requested'))});</script></body></html>`;

await writeFile(resolve(root, 'profile-review-index.html'), html);
console.log(`Review queue: ${resolve(root, 'profile-review-index.html')}`);
