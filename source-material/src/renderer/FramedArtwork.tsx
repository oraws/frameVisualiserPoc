import { OrbitControls, Environment, ContactShadows, Text, PerspectiveCamera, useTexture } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { useMemo } from 'react';
import type { Moulding } from '../mouldings/catalog';
import { pol4100Profile, veronaProfile, type ProfilePoint } from '../mouldings/profiles';
import { createProfileFrameGeometry } from './profileGeometry';

type Props={ moulding:Moulding; artWidth:number; artHeight:number; mount:number; mountColor:string; glass:string; lighting:string; view:string; debug:boolean; artwork:string; geometryMode:'Profile'|'Flat Legacy'; materialMode:'Texture'|'Clay'|'Normal'|'Wireframe'; displayMode:'Inspect'|'Wall'; wallPreset:string };
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
function ProfileFrame({openingWidthMm,openingHeightMm,materialMode,moulding,profile}:{openingWidthMm:number;openingHeightMm:number;materialMode:Props['materialMode'];moulding:Moulding;profile:ProfilePoint[]}) {
  const geometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,profile),[openingWidthMm,openingHeightMm,profile]);
  if(materialMode==='Normal') return <mesh geometry={geometry} castShadow receiveShadow><meshNormalMaterial/></mesh>;
  if(materialMode==='Wireframe') return <mesh geometry={geometry}><meshBasicMaterial color="#d8b976" wireframe/></mesh>;
  if(materialMode==='Clay') return <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial color="#8b8983" roughness={.68}/></mesh>;
  return <mesh geometry={geometry} castShadow receiveShadow>{moulding.sku==='POL-4100'?<Pol4100Material/>:<VeronaProfileMaterial/>}</mesh>;
}
function VeronaProfileMaterial(){
 const map=useTexture('/assets/mouldings/POL-4875/profile-strip.jpg');
 useMemo(()=>{map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=8;map.needsUpdate=true;},[map]);
 return <meshStandardMaterial map={map} color="#7b7780" roughness={.5} metalness={.22} envMapIntensity={.16}/>;
}
function Pol4100Material(){
 const [map,roughnessMap,bumpMap]=useTexture(['/assets/mouldings/POL-4100/basecolor.jpg','/assets/mouldings/POL-4100/roughness.jpg','/assets/mouldings/POL-4100/bump.jpg']);
 useMemo(()=>{for(const texture of [map,roughnessMap,bumpMap]){texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=16;texture.needsUpdate=true;}map.colorSpace=THREE.SRGBColorSpace;},[map,roughnessMap,bumpMap]);
 return <meshStandardMaterial map={map} roughnessMap={roughnessMap} bumpMap={bumpMap} bumpScale={.0065} color="#d2d4d1" roughness={.9} metalness={0} envMapIntensity={.15} flatShading/>;
}
function Framing({moulding,ow,oh,iw,ih,geometryMode,materialMode}:{moulding:Moulding;ow:number;oh:number;iw:number;ih:number;geometryMode:Props['geometryMode'];materialMode:Props['materialMode']}) {
  const profile=moulding.sku==='POL-4875'?veronaProfile:moulding.sku==='POL-4100'?pol4100Profile:null;
  if(profile && geometryMode==='Profile') return <ProfileFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode} moulding={moulding} profile={profile}/>;
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
const roomPresets:Record<string,{image:string;framePosition:[number,number,number];frameScale:number}>={
  'Warm Living Room':{image:'/assets/rooms/warm-living-room.png',framePosition:[.2,.72,0],frameScale:.78},
  'British Fireplace':{image:'/assets/rooms/british-fireplace-room.png',framePosition:[-.68,.42,0],frameScale:.58},
  'Modern Dining Room':{image:'/assets/rooms/modern-dining-room.png',framePosition:[-.2,.72,0],frameScale:.72},
};
function RoomBackdrop({preset}:{preset:string}){
 const room=roomPresets[preset]||roomPresets['Warm Living Room'], map=useTexture(room.image);
 useMemo(()=>{map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=8;map.needsUpdate=true;},[map]);
 return <group>
  <mesh position={[0,.1,-.42]}><planeGeometry args={[11.7,6.58]}/><meshBasicMaterial map={map} toneMapped={false}/></mesh>
 </group>;
}
function Scene(p:Props){
 const m=p.moulding, aw=p.artWidth*mm, ah=p.artHeight*mm, mt=p.mount*mm, fw=m.widthMm*mm, ow=aw+2*(mt+fw), oh=ah+2*(mt+fw), iw=aw+2*mt, ih=ah+2*mt;
 const art=useTexture(p.artwork); art.colorSpace=THREE.SRGBColorSpace;
 const light={"Studio Soft":[3,4,5,1.2,'#fff7e8'],"Window Left":[-4,3,4,2.1,'#e4efff'],"Warm Interior":[2,2,3,1.6,'#ffd4a2'],"Dramatic Raking Light":[-5,.7,2,2.8,'#e9e0c8']}[p.lighting]||[3,4,5,1,'#fff'];
 const wall=p.displayMode==='Wall', room=roomPresets[p.wallPreset]||roomPresets['Warm Living Room'], cam=wall?[0,.1,9.2]:p.view==='Review'?[0,0,4.2]:p.view==='Front'?[0,0,3.75]:p.view==='Detail'?[ow*.28,oh*.28,1.25]:[ow*.35,oh*.22,3.05];
 return <><color attach="background" args={[wall?'#c8c2b7':'#1b1d1b']}/><ambientLight intensity={wall ? .46 : .32}/><directionalLight position={light.slice(0,3) as [number,number,number]} intensity={(light[3] as number)*(wall ? .62 : 1)} color={light[4] as string} castShadow shadow-mapSize={[2048,2048]}/><Environment preset="warehouse" environmentIntensity={wall ? .2 : .38}/>{wall&&<RoomBackdrop preset={p.wallPreset}/>}<group rotation={[0,0,0]} position={wall?room.framePosition:[0,0,0]} scale={wall?room.frameScale:1}>
   {wall&&<mesh position={[.055,-.055,-.03]}><planeGeometry args={[ow+.08,oh+.08]}/><meshBasicMaterial color="#17130f" transparent opacity={.16} depthWrite={false}/></mesh>}
   <mesh position={[0,0,.004]}><boxGeometry args={[iw,ih,.018]}/><meshStandardMaterial color={p.mountColor} roughness={.82}/></mesh>
   <mesh position={[0,0,.015]}><planeGeometry args={[aw,ah]}/><meshBasicMaterial map={art} toneMapped={false}/></mesh>
   <Framing moulding={m} ow={ow} oh={oh} iw={iw} ih={ih} geometryMode={p.geometryMode} materialMode={p.materialMode}/>
   {p.glass!=='None' && <mesh position={[0,0,.033]}><planeGeometry args={[aw,ah]}/><meshPhysicalMaterial transparent opacity={p.glass==='Museum'?.07:.16} roughness={p.glass==='Museum'?.06:.19} metalness={.05} clearcoat={1}/></mesh>}
   {p.debug && <><lineSegments><edgesGeometry args={[new THREE.BoxGeometry(ow,oh,m.depthMm*mm)]}/><lineBasicMaterial color="#e3b65f"/></lineSegments><Text position={[0,-oh/2-.12,.04]} fontSize={.035} color="#d9b86f">{`${Math.round(ow/mm)} × ${Math.round(oh/mm)} mm`}</Text></>}
 </group>{!wall&&<ContactShadows position={[0,-1.1,-.2]} opacity={.45} scale={6} blur={2.5}/>}<OrbitControls key={`controls-${p.displayMode}`} target={[0,wall ? .1 : 0,0]} enableRotate={!wall} enablePan={!wall} screenSpacePanning={!wall} minDistance={wall?7.2:1.05} maxDistance={wall?11:4.2} minPolarAngle={Math.PI*.36} maxPolarAngle={Math.PI*.64}/><PerspectiveCamera key={`camera-${p.displayMode}-${p.view}`} makeDefault position={cam as [number,number,number]} fov={wall?36:p.view==='Detail'?27:33}/></>;
}
export default function FramedArtwork(p:Props){return <Canvas className="canvas" shadows dpr={[1,2]}><Scene {...p}/></Canvas>}
