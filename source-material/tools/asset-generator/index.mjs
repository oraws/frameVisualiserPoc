import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
const sku=process.argv[process.argv.indexOf('--sku')+1];
if(!sku) throw new Error('Usage: npm run asset:prepare -- --sku POL-4875');
const root=resolve('public/assets/mouldings',sku); await mkdir(root,{recursive:true});
const source=resolve(root,'source-product.jpg'); try { await access(source,constants.F_OK); } catch { throw new Error(`Place a supplier product image at ${source}`); }
const metadata={sku, generatedAt:new Date().toISOString(), source:'source-product.jpg', workflow:['Source retained unchanged','Manual crop / seam selection required','Runtime uses deterministic PBR parameters','Normal and roughness maps are future pipeline outputs']};
await writeFile(resolve(root,'asset-preparation.json'),JSON.stringify(metadata,null,2)); console.log(`Prepared metadata for ${sku}`);
