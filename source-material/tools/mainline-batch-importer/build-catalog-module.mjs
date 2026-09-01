#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const project = resolve(import.meta.dirname, '../..');
const sourceRoot = resolve(project, 'source-material/mainline');
const rows = (await readFile('/Users/stephenorawe/Work/invoice-extractor/unique_mouldings.csv', 'utf8')).split(/\r?\n/).slice(1).map(line => line.match(/^"([^"]+)",/i)?.[1]).filter(Boolean);
const existing = new Set(['POL-4211','POL-4418']);
const colourMap = { Black:'#171817', Bronze:'#5c4c3a', Silver:'#b9bdbe', Gold:'#96743b', White:'#e3e1da', Oak:'#a77b47', Walnut:'#60452f', Gunmetal:'#50555a', Grey:'#777873', Teak:'#7c5638' };
const overrides = {
  'POL-4721': { name:'30mm Flats Oak Woodgrain Polcore Moulding', description:'30x16mm Flat Oak Woodgrain Picture Frame Moulding.', details:{colour:'Oak',profile:'Flat',finish:'Wood Grain',range:'30mm Flats'}, dimensions:{length:'2.9m',widthMm:30,depthMm:16,rebateMm:10} }
};

function roughness(finish='') {
  if (/gloss/i.test(finish)) return .24;
  if (/matt/i.test(finish)) return .84;
  if (/wood grain|distressed/i.test(finish)) return .76;
  if (/leaf|antique/i.test(finish)) return .58;
  return .66;
}

function profileType(profile='') {
  if (/l shape/i.test(profile)) return 'l-shape';
  if (/reverse/i.test(profile)) return 'reverse';
  if (/cushion/i.test(profile)) return 'cushion';
  if (/scoop/i.test(profile)) return 'scoop';
  return 'flat';
}

const records = [];
for (const sku of rows) {
  if (existing.has(sku)) continue;
  let metadata;
  try { metadata = JSON.parse(await readFile(resolve(sourceRoot, sku, 'product-metadata.json'), 'utf8')); } catch { continue; }
  metadata = { ...metadata, ...(overrides[sku] || {}), details:{...metadata.details,...(overrides[sku]?.details||{})}, dimensions:overrides[sku]?.dimensions||metadata.dimensions };
  if (!metadata.dimensions) continue;
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(sourceRoot, sku, 'spin-manifest.json'), 'utf8')); } catch { manifest = null; }
  const supplierImages = manifest?.images?.filter((_,index)=>[0,11,22,33,44].includes(index)).map(image=>({label:image.label.replace('img','Rotation '),url:image.originalUrl})) || [];
  const type = profileType(metadata.details?.profile), autoCandidate = type==='flat' && !/SSE|GSE|Edges|Slip|Box/i.test(`${metadata.name} ${metadata.description}`);
  records.push({
    sku,
    supplier:'Mainline',
    name:metadata.name,
    description:metadata.description || metadata.metaDescription,
    widthMm:metadata.dimensions.widthMm,
    depthMm:metadata.dimensions.depthMm,
    rebateMm:metadata.dimensions.rebateMm || Math.max(1,Math.round(metadata.dimensions.depthMm*.55)),
    profileType:type,
    finish:[metadata.details?.colour,metadata.details?.finish,metadata.details?.range].filter(Boolean).join(' · '),
    baseColor:colourMap[metadata.details?.colour] || '#5d5b55',
    roughness:roughness(metadata.details?.finish),
    ornament:type==='flat'?.08:.45,
    renderStatus:autoCandidate?'auto-candidate':'supplier-reference',
    discontinued:Boolean(metadata.discontinued),
    confidence:{shape:autoCandidate?'Auto candidate':'Supplier review',dimensions:'High',texture:manifest?'Supplier assets imported':'Product images only',colour:'Supplier description',material:'Unapproved'},
    sourceUrl:metadata.productUrl,
    supplierImages
  });
}

await writeFile(resolve(project, 'src/mouldings/invoiceMouldings.json'), `${JSON.stringify(records, null, 2)}\n`);
console.log(`Generated ${records.length} invoice catalogue entries`);
