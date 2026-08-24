import * as THREE from 'three';
import type { ProfilePoint } from '../mouldings/profiles';

export const MM_TO_WORLD = 0.0025;

/** Sweeps a u/z moulding profile around an opening as four independently UV-mapped mitred sides. */
export function createProfileFrameGeometry(openingWidthMm:number, openingHeightMm:number, profile:ProfilePoint[]) {
  const positions:number[]=[]; const indices:number[]=[];
  const addVertex=(x:number,y:number,z:number,u:number,v:number)=>{positions.push(x,y,z,u,v); return positions.length/5-1;};
  const sides=[
    (hw:number,hh:number,z:number)=>[[-hw,hh,z],[hw,hh,z]],
    (hw:number,hh:number,z:number)=>[[hw,hh,z],[hw,-hh,z]],
    (hw:number,hh:number,z:number)=>[[hw,-hh,z],[-hw,-hh,z]],
    (hw:number,hh:number,z:number)=>[[-hw,-hh,z],[-hw,hh,z]]
  ];
  sides.forEach((side, sideIndex)=>{
    const rows:number[][]=[];
    profile.forEach(([uMm,zMm])=>{
      const hw=(openingWidthMm/2+uMm)*MM_TO_WORLD, hh=(openingHeightMm/2+uMm)*MM_TO_WORLD;
      const corners=side(hw,hh,zMm*MM_TO_WORLD) as number[][];
      const runMm=(sideIndex===0||sideIndex===2 ? openingWidthMm+2*uMm : openingHeightMm+2*uMm);
      rows.push(corners.map((p, end)=>addVertex(p[0],p[1],p[2],end?runMm/130:0,uMm/97)));
    });
    for(let i=0;i<rows.length-1;i++){ const [a,b]=rows[i], [c,d]=rows[i+1]; indices.push(a,b,c,b,d,c); }
  });
  // Close the visible profile into the backing plane at its inner and outer edges.
  for (const edge of [0,profile.length-1]) for(let s=0;s<4;s++){
    const base=(s*profile.length+edge)*2, a=base,b=base+1;
    const ax=positions[a*5],ay=positions[a*5+1], bx=positions[b*5],by=positions[b*5+1];
    const a0=addVertex(ax,ay,.008,0,0),b0=addVertex(bx,by,.008,1,0); indices.push(a,b,a0,b,b0,a0);
  }
  const geometry=new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions.filter((_,i)=>i%5<3),3)); geometry.setAttribute('uv',new THREE.Float32BufferAttribute(positions.filter((_,i)=>i%5>=3),2)); geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}
