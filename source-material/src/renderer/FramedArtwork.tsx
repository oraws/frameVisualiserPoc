import { OrbitControls, Environment, ContactShadows, Text, PerspectiveCamera, useTexture } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { useMemo } from 'react';
import type { Moulding } from '../mouldings/catalog';
import { veronaProfile } from '../mouldings/profiles';
import { createProfileFrameGeometry } from './profileGeometry';

type Props={ moulding:Moulding; artWidth:number; artHeight:number; mount:number; mountColor:string; glass:string; lighting:string; view:string; debug:boolean; artwork:string; geometryMode:'Profile'|'Flat Legacy'; materialMode:'Texture'|'Clay'|'Normal'|'Wireframe' };
const mm=0.0025;
function shape(points:number[][]) { return new THREE.Shape(points.map(([x,y])=>new THREE.Vector2(x,y))); }
function OrnateMaterial(){
  const map=useTexture('/assets/mouldings/POL-4875/profile-strip.jpg');
  useMemo(()=>{map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(3.5,1.4);map.anisotropy=8;map.needsUpdate=true;},[map]);
  return <meshStandardMaterial map={map} color="#8d8990" roughness={.53} metalness={.26} envMapIntensity={.16}/>;
}
function Rail({points, moulding, depth}:{points:number[][];moulding:Moulding;depth?:number}) {
  const d=depth ?? moulding.depthMm*mm;
  const geometry=useMemo(()=>new THREE.ExtrudeGeometry(shape(points),{depth:d,bevelEnabled:true,bevelThickness:Math.min(.009,d*.16),bevelSize:.007,bevelSegments:3}),[points,d]);
  return <mesh geometry={geometry} castShadow receiveShadow>{moulding.profileType==='ornate-scoop' ? <OrnateMaterial/> : <meshPhysicalMaterial color={moulding.baseColor} roughness={moulding.roughness} metalness={moulding.sku==='4925BG'?.08:.02} clearcoat={.08} envMapIntensity={.18}/>}</mesh>;
}
function railSet(ow:number,oh:number,iw:number,ih:number):number[][][] { return [ [[-ow/2,oh/2],[ow/2,oh/2],[iw/2,ih/2],[-iw/2,ih/2]], [[-ow/2,-oh/2],[-iw/2,-ih/2],[iw/2,-ih/2],[ow/2,-oh/2]], [[-ow/2,-oh/2],[-iw/2,-ih/2],[-iw/2,ih/2],[-ow/2,oh/2]], [[ow/2,-oh/2],[iw/2,-ih/2],[iw/2,ih/2],[ow/2,oh/2]] ]; }
function ProfileFrame({openingWidthMm,openingHeightMm,materialMode}:{openingWidthMm:number;openingHeightMm:number;materialMode:Props['materialMode']}) {
  const geometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,veronaProfile),[openingWidthMm,openingHeightMm]);
  const map=useTexture('/assets/mouldings/POL-4875/profile-strip.jpg');
  useMemo(()=>{map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=8;map.needsUpdate=true;},[map]);
  if(materialMode==='Normal') return <mesh geometry={geometry} castShadow receiveShadow><meshNormalMaterial/></mesh>;
  if(materialMode==='Wireframe') return <mesh geometry={geometry}><meshBasicMaterial color="#d8b976" wireframe/></mesh>;
  if(materialMode==='Clay') return <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial color="#8b8983" roughness={.68}/></mesh>;
  return <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial map={map} color="#7b7780" roughness={.5} metalness={.22} envMapIntensity={.16}/></mesh>;
}
function Framing({moulding,ow,oh,iw,ih,geometryMode,materialMode}:{moulding:Moulding;ow:number;oh:number;iw:number;ih:number;geometryMode:Props['geometryMode'];materialMode:Props['materialMode']}) {
  if(moulding.sku==='POL-4875' && geometryMode==='Profile') return <ProfileFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode}/>;
  const d=moulding.depthMm*mm, gold=moulding.accentColor || '#534b40', trim=moulding.sku==='4925BG';
  const rails=railSet(ow,oh,iw,ih);
  const line=.011, inset=.018;
  return <group>{rails.map((p,i)=><Rail key={i} points={p} moulding={moulding}/>)}
    {moulding.profileType==='ornate-scoop' && <group position={[0,0,d+.002]}>
      <group position={[0,0,.006]}>{railSet(ow-.035,oh-.035,iw+.10,ih+.10).map((p,i)=><Rail key={`relief-${i}`} points={p} moulding={moulding} depth={.012}/>)}</group>
      <group position={[0,0,.021]}>{railSet(ow-.012,oh-.012,ow-.054,oh-.054).map((p,i)=><Rail key={`outer-bead-${i}`} points={p} moulding={moulding} depth={.008}/>)}</group>
      <group position={[0,0,.025]}>{railSet(iw+.075,ih+.075,iw+.035,ih+.035).map((p,i)=><Rail key={`inner-bead-${i}`} points={p} moulding={moulding} depth={.007}/>)}</group>
    </group>}
    {trim && <group position={[0,0,d+.003]}>{[[[iw,line,.008],[0,ih/2+inset,0]],[[iw,line,.008],[0,-ih/2-inset,0]],[[line,ih,.008],[iw/2+inset,0,0]],[[line,ih,.008],[-iw/2-inset,0,0]]].map(([args,pos],i)=><mesh key={i} position={pos as [number,number,number]}><boxGeometry args={args as [number,number,number]}/><meshPhysicalMaterial color={gold} metalness={.72} roughness={.24} envMapIntensity={.3}/></mesh>)}</group>}
  </group>;
}
function Scene(p:Props){
 const m=p.moulding, aw=p.artWidth*mm, ah=p.artHeight*mm, mt=p.mount*mm, fw=m.widthMm*mm, ow=aw+2*(mt+fw), oh=ah+2*(mt+fw), iw=aw+2*mt, ih=ah+2*mt;
 const art=useTexture(p.artwork); art.colorSpace=THREE.SRGBColorSpace;
 const light={"Studio Soft":[3,4,5,1.2,'#fff7e8'],"Window Left":[-4,3,4,2.1,'#e4efff'],"Warm Interior":[2,2,3,1.6,'#ffd4a2'],"Dramatic Raking Light":[-5,.7,2,2.8,'#e9e0c8']}[p.lighting]||[3,4,5,1,'#fff'];
 const cam=p.view==='Front'?[0,0,3.4]:p.view==='Detail'?[ow*.28,oh*.28,1.25]:[ow*.35,oh*.22,3.05];
 return <><color attach="background" args={['#1b1d1b']}/><ambientLight intensity={.32}/><directionalLight position={light.slice(0,3) as [number,number,number]} intensity={light[3] as number} color={light[4] as string} castShadow shadow-mapSize={[2048,2048]}/><Environment preset="warehouse" environmentIntensity={.38}/><group rotation={[0,0,0]}>
   <mesh position={[0,0,-.035]} receiveShadow><boxGeometry args={[ow+.18,oh+.18,.04]}/><meshStandardMaterial color="#c8c3b7" roughness={.92}/></mesh>
   <mesh position={[0,0,.004]}><boxGeometry args={[iw,ih,.018]}/><meshStandardMaterial color={p.mountColor} roughness={.82}/></mesh>
   <mesh position={[0,0,.015]}><planeGeometry args={[aw,ah]}/><meshBasicMaterial map={art} toneMapped={false}/></mesh>
   {p.mount>0 && <mesh position={[0,0,.022]}><ringGeometry args={[Math.min(aw,ah)*.01,Math.max(iw,ih)*.7,4,1,0,Math.PI*2]}/><meshBasicMaterial transparent opacity={0}/></mesh>}
   <Framing moulding={m} ow={ow} oh={oh} iw={iw} ih={ih} geometryMode={p.geometryMode} materialMode={p.materialMode}/>
   {p.glass!=='None' && <mesh position={[0,0,.033]}><planeGeometry args={[aw,ah]}/><meshPhysicalMaterial transparent opacity={p.glass==='Museum'?.07:.16} roughness={p.glass==='Museum'?.06:.19} metalness={.05} clearcoat={1}/></mesh>}
   {p.debug && <><lineSegments><edgesGeometry args={[new THREE.BoxGeometry(ow,oh,m.depthMm*mm)]}/><lineBasicMaterial color="#e3b65f"/></lineSegments><Text position={[0,-oh/2-.12,.04]} fontSize={.035} color="#d9b86f">{`${Math.round(ow/mm)} × ${Math.round(oh/mm)} mm`}</Text></>}
 </group><ContactShadows position={[0,-1.1,-.2]} opacity={.45} scale={6} blur={2.5}/><OrbitControls target={[0,0,0]} minDistance={1.05} maxDistance={4.2} minPolarAngle={Math.PI*.36} maxPolarAngle={Math.PI*.64}/><PerspectiveCamera makeDefault position={cam as [number,number,number]} fov={p.view==='Detail'?27:33}/></>;
}
export default function FramedArtwork(p:Props){return <Canvas className="canvas" shadows dpr={[1,2]}><Scene {...p}/></Canvas>}
