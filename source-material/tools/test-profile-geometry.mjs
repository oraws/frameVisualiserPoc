import { readFile } from 'node:fs/promises';
const profile=JSON.parse(await readFile('public/assets/mouldings/POL-4875/profile.json','utf8'));
const opening=[800,600], width=profile.widthMm, expected=[994,794];
const actual=opening.map(v=>v+2*width);
if(actual.some((v,i)=>v!==expected[i])) throw new Error(`outside dimensions ${actual} are not ${expected}`);
if(profile.points.some(([u,z])=>!Number.isFinite(u)||!Number.isFinite(z)||u<0||u>width||z<0||z>profile.depthMm)) throw new Error('invalid profile coordinate');
if(profile.points.length<15) throw new Error('profile is undersampled');
console.log('profile dimensions and sampled coordinates valid');
