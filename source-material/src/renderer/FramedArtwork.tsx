import { OrbitControls, Environment, ContactShadows, Text, PerspectiveCamera, useTexture } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import type { Moulding } from '../mouldings/catalog';
import { centradoProfile, flat54x20Profile, mainlineCatalogueProfile, pol4100Profile, pol4508BlackProfile, pol4508SamBlackProfile, pol4508SamSilverProfile, pol4508SilverProfile, veronaProfile, veronaSamProfile, type ProfilePoint } from '../mouldings/profiles';
import { createProfileFrameGeometry } from './profileGeometry';
import { fallbackRoom, roomPresets, type RoomTemplate } from './roomTemplates';

type ProfileVariant='Current'|'SAM 2.1'|'Catalogue';
type ScaleReference={lengthMm:number;pointsNormalised:number[][]};
type RoomCalibration={manualCalibration?:{quadNormalised:number[][];scaleReference?:ScaleReference};renderer?:{wallYawDegrees?:number;wallPitchDegrees?:number}};
type Props={ moulding:Moulding; artWidth:number; artHeight:number; mount:number; mountColor:string; glass:string; lighting:string; lightStrength:number; ambientFill:number; exposure:number; wallColour:string; view:string; debug:boolean; artwork:string; geometryMode:'Profile'|'Flat Legacy'; materialMode:'Texture'|'Clay'|'Normal'|'Wireframe'; displayMode:'Inspect'|'Wall'; wallPreset:string; wallPositionX:number; wallPositionY:number; wallScale:number; wallShadow:number; materialVariant:string; profileVariant:ProfileVariant; roomCalibration?:RoomCalibration|null };
const mm=0.0025;
function roomPlaneMetrics(room:RoomTemplate,size:{width:number;height:number}){
 const planeZ=-.42, cameraZ=room.camera.position[2], viewHeight=2*(cameraZ-planeZ)*Math.tan(THREE.MathUtils.degToRad(room.camera.fov/2));
 if(!room.imageAspect)return{width:11.7,height:6.58,centerX:0,centerY:.1,planeZ};
 const viewWidth=viewHeight*(size.width/Math.max(1,size.height));
 let width:number,height:number;
 if(viewWidth/viewHeight<room.imageAspect){height=viewHeight;width=height*room.imageAspect;}
 else{width=viewWidth;height=width/room.imageAspect;}
 const centerX=room.imageAnchorX==='left'?-viewWidth/2+width/2:0;
 return{width,height,centerX,centerY:.1,planeZ};
}
function quadHomography(quad:number[][]){
 const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]=quad;
 const dx1=x1-x2,dx2=x3-x2,dy1=y1-y2,dy2=y3-y2,sx=x0-x1+x2-x3,sy=y0-y1+y2-y3,denominator=dx1*dy2-dx2*dy1;
 const g=Math.abs(denominator)>1e-8?(sx*dy2-dx2*sy)/denominator:0,h=Math.abs(denominator)>1e-8?(dx1*sy-sx*dy1)/denominator:0;
 return[x1-x0+g*x1,x3-x0+h*x3,x0,y1-y0+g*y1,y3-y0+h*y3,y0,g,h,1];
}
function transformPoint(matrix:number[],point:number[]){const denominator=matrix[6]*point[0]+matrix[7]*point[1]+matrix[8];return[(matrix[0]*point[0]+matrix[1]*point[1]+matrix[2])/denominator,(matrix[3]*point[0]+matrix[4]*point[1]+matrix[5])/denominator];}
const cross3=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const imageLine=(a:number[],b:number[])=>cross3([a[0],a[1],1],[b[0],b[1],1]);
function vanishingDirection(a:number[],b:number[],c:number[],d:number[],focal:number,cx:number,cy:number){
 const point=cross3(imageLine(a,b),imageLine(c,d)),direction=new THREE.Vector3((point[0]-cx*point[2])/focal,(point[1]-cy*point[2])/focal,point[2]);
 return direction.normalize();
}
function calibratedFramePose(quad:number[][],size:{width:number;height:number},room:RoomTemplate,calibration?:RoomCalibration|null){
 const imageAspect=room.imageAspect||size.width/Math.max(1,size.height),stageAspect=size.width/Math.max(1,size.height);
 let displayedWidth:number,displayedHeight:number,offsetX=0,offsetY=0;
 if(stageAspect<imageAspect){displayedHeight=size.height;displayedWidth=displayedHeight*imageAspect;offsetX=room.imageAnchorX==='left'?0:(size.width-displayedWidth)/2;}
 else{displayedWidth=size.width;displayedHeight=displayedWidth/imageAspect;offsetY=(size.height-displayedHeight)/2;}
 const toPixels=(point:number[])=>[offsetX+point[0]*displayedWidth,offsetY+point[1]*displayedHeight],pixelQuad=quad.map(toPixels),reference=calibration?.manualCalibration?.scaleReference||{lengthMm:2400,pointsNormalised:[[.12,.18],[.12,.72]]},referenceStart=toPixels(reference.pointsNormalised[0]),referenceEnd=toPixels(reference.pointsNormalised[1]),referencePixels=Math.max(1,Math.hypot(referenceEnd[0]-referenceStart[0],referenceEnd[1]-referenceStart[1])),focal=size.height/(2*Math.tan(THREE.MathUtils.degToRad(room.camera.fov/2))),cx=size.width/2,cy=size.height/2;
 const right=vanishingDirection(pixelQuad[0],pixelQuad[1],pixelQuad[3],pixelQuad[2],focal,cx,cy),up=vanishingDirection(pixelQuad[3],pixelQuad[0],pixelQuad[2],pixelQuad[1],focal,cx,cy);
 if(right.x<0)right.multiplyScalar(-1);if(up.y>0)up.multiplyScalar(-1);up.addScaledVector(right,-right.dot(up)).normalize();const normal=new THREE.Vector3().crossVectors(right,up).normalize();
 const referenceCentre=[(referenceStart[0]+referenceEnd[0])/2,(referenceStart[1]+referenceEnd[1])/2],referenceDepth=focal*(reference.lengthMm*mm)/referencePixels,referencePoint=new THREE.Vector3((referenceCentre[0]-cx)*referenceDepth/focal,(referenceCentre[1]-cy)*referenceDepth/focal,referenceDepth),center=toPixels(transformPoint(quadHomography(quad),[.5,.5])),centreRay=new THREE.Vector3((center[0]-cx)/focal,(center[1]-cy)/focal,1),depth=normal.dot(referencePoint)/normal.dot(centreRay),translation=centreRay.multiplyScalar(depth);
 const toThree=(vector:THREE.Vector3)=>new THREE.Vector3(vector.x,-vector.y,-vector.z),rotation=new THREE.Matrix4().makeBasis(toThree(right),toThree(up),toThree(normal));
 return{position:[translation.x,room.camera.position[1]-translation.y,room.camera.position[2]-translation.z] as [number,number,number],quaternion:new THREE.Quaternion().setFromRotationMatrix(rotation)};
}
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
function ProfileFrame({openingWidthMm,openingHeightMm,materialMode,moulding,profile,materialVariant}:{openingWidthMm:number;openingHeightMm:number;materialMode:Props['materialMode'];moulding:Moulding;profile:ProfilePoint[];materialVariant:string}) {
  const geometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,profile),[openingWidthMm,openingHeightMm,profile]);
  if(materialMode==='Normal') return <mesh geometry={geometry} castShadow receiveShadow><meshNormalMaterial/></mesh>;
  if(materialMode==='Wireframe') return <mesh geometry={geometry}><meshBasicMaterial color="#d8b976" wireframe/></mesh>;
  if(materialMode==='Clay') return <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial color="#8b8983" roughness={.68}/></mesh>;
  const hasApprovedMaps=['POL-4100','POL-4508','POL-4418','POL-4211'].includes(moulding.sku);
  return <mesh geometry={geometry} castShadow receiveShadow>{moulding.sku==='POL-4875'?<VeronaProfileMaterial/>:hasApprovedMaps?<SupplierVariantMaterial moulding={moulding} variant={materialVariant}/>:<meshStandardMaterial color={moulding.baseColor} roughness={moulding.roughness} metalness={/Gold|Silver|Bronze|Gunmetal/i.test(moulding.finish)?.12:0} envMapIntensity={.18} flatShading/>}</mesh>;
}
function VeronaProfileMaterial(){
 const map=useTexture('/assets/mouldings/POL-4875/profile-strip.jpg');
 useMemo(()=>{map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=8;map.needsUpdate=true;},[map]);
 return <meshStandardMaterial map={map} color="#7b7780" roughness={.5} metalness={.22} envMapIntensity={.16}/>;
}
function SupplierVariantMaterial({moulding,variant}:{moulding:Moulding;variant:string}){
 const selected=moulding.sku==='POL-4100'&&variant!=='multiframe-experiment-v1'?'baseline-v1':'multiframe-experiment-v1', root=`/assets/mouldings/${moulding.sku}/variants/${selected}`;
 const [map,roughnessMap,bumpMap]=useTexture([`${root}/basecolor.jpg`,`${root}/roughness.jpg`,`${root}/bump.jpg`]);
 useMemo(()=>{for(const texture of [map,roughnessMap,bumpMap]){texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=16;texture.needsUpdate=true;}map.colorSpace=THREE.SRGBColorSpace;},[map,roughnessMap,bumpMap]);
 const settings:Record<string,{bump:number;roughness:number;metalness:number;env:number;color:string}>={
  'POL-4100':{bump:.0065,roughness:.9,metalness:0,env:.15,color:'#d2d4d1'},
  'POL-4508':{bump:.00018,roughness:.82,metalness:0,env:.16,color:'#393b39'},
  'POL-4418':{bump:.00035,roughness:.66,metalness:.08,env:.2,color:'#c7ac90'},
  'POL-4211':{bump:.00045,roughness:.78,metalness:0,env:.16,color:'#e1d7c8'},
 };
 const s=settings[moulding.sku]||settings['POL-4100'];
 return <meshStandardMaterial map={map} roughnessMap={roughnessMap} bumpMap={bumpMap} bumpScale={s.bump} color={s.color} roughness={s.roughness} metalness={s.metalness} envMapIntensity={s.env} flatShading/>;
}
function splitProfile(profile:ProfilePoint[],cutoff:number):[ProfilePoint[],ProfilePoint[]]{
 const crossing=profile.findIndex(([u])=>u>=cutoff);
 if(crossing<=0)return [profile,profile];
 const before=profile[crossing-1],after=profile[crossing];
 const ratio=(cutoff-before[0])/Math.max(after[0]-before[0],1e-6);
 const join:[number,number]=[cutoff,before[1]+(after[1]-before[1])*ratio];
 return [[...profile.slice(0,crossing),join],[join,...profile.slice(crossing)]];
}
function CentradoMaterial({moulding,part,mode}:{moulding:Moulding;part:'base'|'accent';mode:Props['materialMode']}){
 const [map,bumpMap]=useTexture([`/assets/mouldings/${moulding.sku}/${part}-texture.jpg`,`/assets/mouldings/${moulding.sku}/${part}-bump.jpg`]);
 useMemo(()=>{for(const texture of [map,bumpMap]){texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=16;texture.needsUpdate=true;}map.colorSpace=THREE.SRGBColorSpace;map.repeat.set(1.8,1);bumpMap.repeat.copy(map.repeat);},[map,bumpMap]);
 if(mode==='Normal')return <meshNormalMaterial/>;
 if(mode==='Wireframe')return <meshBasicMaterial color={part==='accent'?(moulding.accentColor||'#d4a63d'):'#d8b976'} wireframe/>;
 if(mode==='Clay')return <meshStandardMaterial color="#8b8983" roughness={.68}/>;
 const metallic=/gold|silver|bronze|lustre/i.test(part==='accent'?(moulding.accentColor||moulding.finish):moulding.finish);
 return <meshPhysicalMaterial map={map} bumpMap={bumpMap} bumpScale={part==='accent'?.0008:.00115} color="#ffffff" metalness={metallic?.42:.01} roughness={part==='accent'?.42:moulding.roughness} clearcoat={part==='accent'?.12:.04} envMapIntensity={part==='accent'?.4:.2}/>;
}
function CentradoFrame({openingWidthMm,openingHeightMm,materialMode,moulding,profile}:{openingWidthMm:number;openingHeightMm:number;materialMode:Props['materialMode'];moulding:Moulding;profile:ProfilePoint[]}){
 const accentWidth=moulding.accentWidthMm||0;
 const [accentProfile,remainder]=useMemo(()=>splitProfile(profile,accentWidth),[profile,accentWidth]);
 const baseProfile=accentWidth>0?remainder:profile;
 const baseGeometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,baseProfile),[openingWidthMm,openingHeightMm,baseProfile]);
 const accentGeometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,accentProfile),[openingWidthMm,openingHeightMm,accentProfile]);
 return <group><mesh geometry={baseGeometry} castShadow receiveShadow><CentradoMaterial moulding={moulding} part="base" mode={materialMode}/></mesh>{accentWidth>0&&<mesh geometry={accentGeometry} castShadow receiveShadow><CentradoMaterial moulding={moulding} part="accent" mode={materialMode}/></mesh>}</group>;
}
function ParamountSilverMaterial({mode,moulding}:{mode:Props['materialMode'];moulding:Moulding}){
 if(mode==='Normal') return <meshNormalMaterial/>;
 if(mode==='Wireframe') return <meshBasicMaterial color="#d8b976" wireframe/>;
 if(mode==='Clay') return <meshStandardMaterial color="#8b8983" roughness={.68}/>;
 return <meshPhysicalMaterial color={moulding.accentColor||'#c5c2b9'} metalness={.82} roughness={.23} clearcoat={.12} envMapIntensity={.56}/>;
}
function ParamountFrame({openingWidthMm,openingHeightMm,materialMode,moulding,materialVariant}:{openingWidthMm:number;openingHeightMm:number;materialMode:Props['materialMode'];moulding:Moulding;materialVariant:string}){
 const accentWidth=moulding.accentWidthMm||9.5;
 const silverGeometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,pol4508SilverProfile),[openingWidthMm,openingHeightMm]);
 return <group>
  <ProfileFrame openingWidthMm={openingWidthMm+2*accentWidth} openingHeightMm={openingHeightMm+2*accentWidth} materialMode={materialMode} moulding={moulding} profile={pol4508BlackProfile} materialVariant={materialVariant}/>
  <mesh geometry={silverGeometry} castShadow receiveShadow><ParamountSilverMaterial mode={materialMode} moulding={moulding}/></mesh>
 </group>;
}
function ParamountSamFrame({openingWidthMm,openingHeightMm,materialMode,moulding,materialVariant}:{openingWidthMm:number;openingHeightMm:number;materialMode:Props['materialMode'];moulding:Moulding;materialVariant:string}){
 const silverGeometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,pol4508SamSilverProfile),[openingWidthMm,openingHeightMm]);
 return <group>
  <ProfileFrame openingWidthMm={openingWidthMm} openingHeightMm={openingHeightMm} materialMode={materialMode} moulding={moulding} profile={pol4508SamBlackProfile} materialVariant={materialVariant}/>
  <mesh geometry={silverGeometry} castShadow receiveShadow><ParamountSilverMaterial mode={materialMode} moulding={moulding}/></mesh>
 </group>;
}
function ParamountCatalogueFrame({openingWidthMm,openingHeightMm,materialMode,moulding,materialVariant,profile}:{openingWidthMm:number;openingHeightMm:number;materialMode:Props['materialMode'];moulding:Moulding;materialVariant:string;profile:ProfilePoint[]}){
 const [silverProfile,blackProfile]=useMemo(()=>splitProfile(profile,moulding.accentWidthMm||9.5),[profile,moulding.accentWidthMm]);
 const silverGeometry=useMemo(()=>createProfileFrameGeometry(openingWidthMm,openingHeightMm,silverProfile),[openingWidthMm,openingHeightMm,silverProfile]);
 return <group>
  <ProfileFrame openingWidthMm={openingWidthMm} openingHeightMm={openingHeightMm} materialMode={materialMode} moulding={moulding} profile={blackProfile} materialVariant={materialVariant}/>
  <mesh geometry={silverGeometry} castShadow receiveShadow><ParamountSilverMaterial mode={materialMode} moulding={moulding}/></mesh>
 </group>;
}
function Framing({moulding,ow,oh,iw,ih,geometryMode,materialMode,materialVariant,profileVariant}:{moulding:Moulding;ow:number;oh:number;iw:number;ih:number;geometryMode:Props['geometryMode'];materialMode:Props['materialMode'];materialVariant:string;profileVariant:Props['profileVariant']}) {
  const supplierProfile=moulding.supplier==='Centrado'?centradoProfile(moulding.sku):undefined;
  const catalogueProfile=profileVariant==='Catalogue'?mainlineCatalogueProfile(moulding.sku):undefined;
  if(supplierProfile&&geometryMode==='Profile') return <CentradoFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode} moulding={moulding} profile={supplierProfile}/>;
  if(catalogueProfile&&moulding.sku==='POL-4508'&&geometryMode==='Profile') return <ParamountCatalogueFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode} moulding={moulding} materialVariant={materialVariant} profile={catalogueProfile}/>;
  if(catalogueProfile&&geometryMode==='Profile') return <ProfileFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode} moulding={moulding} profile={catalogueProfile} materialVariant={materialVariant}/>;
  if(moulding.sku==='POL-4508'&&geometryMode==='Profile'&&profileVariant==='SAM 2.1') return <ParamountSamFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode} moulding={moulding} materialVariant={materialVariant}/>;
  if(moulding.sku==='POL-4508'&&geometryMode==='Profile') return <ParamountFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode} moulding={moulding} materialVariant={materialVariant}/>;
  const profiles:Record<string,ProfilePoint[]>={'POL-4875':profileVariant==='SAM 2.1'?veronaSamProfile:veronaProfile,'POL-4100':pol4100Profile,'POL-4418':flat54x20Profile,'POL-4211':flat54x20Profile};
  const rebateFloor=Math.max(1,moulding.depthMm-moulding.rebateMm);
  const genericFlatProfile:ProfilePoint[]=[[0,rebateFloor],[Math.min(2,moulding.widthMm*.08),rebateFloor],[Math.min(3.5,moulding.widthMm*.13),moulding.depthMm],[moulding.widthMm,moulding.depthMm]];
  const profile=profiles[moulding.sku] || (moulding.renderStatus==='auto-candidate'&&moulding.profileType==='flat'?genericFlatProfile:undefined);
  if(profile && geometryMode==='Profile') return <ProfileFrame openingWidthMm={iw/mm} openingHeightMm={ih/mm} materialMode={materialMode} moulding={moulding} profile={profile} materialVariant={materialVariant}/>;
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
function Exposure({value}:{value:number}){const {gl}=useThree();useEffect(()=>{gl.toneMappingExposure=value},[gl,value]);return null;}
function RoomBackdrop({preset,tint}:{preset:string;tint:string}){
 const room=roomPresets[preset]||fallbackRoom, map=useTexture(room.image),{size}=useThree(),plane=roomPlaneMetrics(room,size);
 useMemo(()=>{map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=8;map.needsUpdate=true;},[map]);
 return <group renderOrder={-100}>
  <mesh position={[plane.centerX,plane.centerY,plane.planeZ]} renderOrder={-100}><planeGeometry args={[plane.width,plane.height]}/><meshBasicMaterial map={map} toneMapped={false} depthTest={false} depthWrite={false}/></mesh>
  <mesh position={[plane.centerX,plane.centerY,plane.planeZ+.005]} renderOrder={-99}><planeGeometry args={[plane.width,plane.height]}/><meshBasicMaterial color={tint} transparent opacity={room.tintOpacity} toneMapped={false} depthTest={false} depthWrite={false}/></mesh>
 </group>;
}
function Scene(p:Props){
 const {size}=useThree();
 const m=p.moulding, aw=p.artWidth*mm, ah=p.artHeight*mm, mt=p.mount*mm, experimental4508=m.sku==='POL-4508'&&p.profileVariant==='SAM 2.1', catalogueCandidate=p.profileVariant==='Catalogue'&&!!mainlineCatalogueProfile(m.sku), includedAccent=m.supplier==='Centrado'||experimental4508||catalogueCandidate, fw=(m.widthMm+(includedAccent?0:(m.accentWidthMm||0)))*mm, ow=aw+2*(mt+fw), oh=ah+2*(mt+fw), iw=aw+2*mt, ih=ah+2*mt;
 const art=useTexture(p.artwork); art.colorSpace=THREE.SRGBColorSpace;
 const light={"Studio Soft":[3,4,5,1.2,'#fff7e8'],"Window Left":[-4,3,4,2.1,'#e4efff'],"Warm Interior":[2,2,3,1.6,'#ffd4a2'],"Dramatic Raking Light":[-5,.7,2,2.8,'#e9e0c8']}[p.lighting]||[3,4,5,1,'#fff'];
 const wall=p.displayMode==='Wall', room=roomPresets[p.wallPreset]||fallbackRoom;
 const detailTarget:[number,number,number]=[ow*.38,oh*.36,0], orbitTarget:[number,number,number]=p.view==='Detail'?detailTarget:[0,wall?.1:0,0];
 const cam=wall?room.camera.position:p.view==='Review'?[0,0,4.2]:p.view==='Front'?[0,0,3.75]:p.view==='Detail'?[detailTarget[0]+.34,detailTarget[1]+.24,.9]:[ow*.35,oh*.22,3.05];
 const metricRebate=m.sku==='POL-4508'||m.supplier==='Centrado'||catalogueCandidate, rebateFront=metricRebate?(m.depthMm-m.rebateMm)*mm:.013, mountZ=metricRebate?rebateFront-.009:.004, artZ=metricRebate?rebateFront+.002:.015, glassZ=metricRebate?rebateFront+.006:.033;
 let wallPosition:[number,number,number]=[room.framePosition[0]+p.wallPositionX*1.35,room.framePosition[1]+p.wallPositionY*.8,room.framePosition[2]],wallQuaternion=new THREE.Quaternion().setFromEuler(new THREE.Euler(...room.frameRotation)),wallScale=room.frameScale*p.wallScale;
 const approvedQuad=p.roomCalibration?.manualCalibration?.quadNormalised;
 if(wall&&room.imageAspect&&approvedQuad?.length===4){
  const pose=calibratedFramePose(approvedQuad,size,room,p.roomCalibration);
  wallPosition=[pose.position[0]+p.wallPositionX*1.35,pose.position[1]+p.wallPositionY*.8,pose.position[2]];
  wallQuaternion=pose.quaternion;
  wallScale=p.wallScale;
 }
 const activeLight=wall?room.keyLight:{position:light.slice(0,3) as [number,number,number],intensity:light[3] as number,color:light[4] as string};
 return <><Exposure value={p.exposure*(wall?1.16:1)}/><color attach="background" args={[p.wallColour]}/><ambientLight intensity={(wall?room.ambient:.32)*p.ambientFill}/>{wall&&<><hemisphereLight args={['#f7f0e3','#756b5e',.42*p.ambientFill]}/><directionalLight position={[4.2,1.8,4.6]} intensity={.38*p.ambientFill} color="#dce7f2"/></>}<directionalLight position={activeLight.position} intensity={activeLight.intensity*p.lightStrength} color={activeLight.color} castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-4} shadow-camera-right={4} shadow-camera-top={4} shadow-camera-bottom={-4} shadow-bias={wall?room.shadow.bias:-.0001} shadow-normalBias={wall?.0007:0} shadow-radius={wall?room.shadow.radius:3}/><Environment preset="warehouse" environmentIntensity={(wall?room.environment:.38)*Math.max(.65,p.ambientFill)}/>{wall&&<RoomBackdrop preset={p.wallPreset} tint={p.wallColour}/>}<group quaternion={wall?wallQuaternion:new THREE.Quaternion()} position={wall?wallPosition:[0,0,0]} scale={wall?wallScale:1}>
   {wall&&<mesh position={[0,0,-.01]} receiveShadow><planeGeometry args={[ow+1.05,oh+1.05]}/><shadowMaterial color={room.shadow.color} transparent opacity={room.shadow.opacity*p.wallShadow} depthWrite={false}/></mesh>}
   <mesh position={[0,0,mountZ]}><boxGeometry args={[iw,ih,.018]}/><meshStandardMaterial color={p.mountColor} roughness={.82}/></mesh>
   <mesh position={[0,0,artZ]}><planeGeometry args={[aw,ah]}/><meshBasicMaterial map={art} toneMapped={false}/></mesh>
   <Framing moulding={m} ow={ow} oh={oh} iw={iw} ih={ih} geometryMode={p.geometryMode} materialMode={p.materialMode} materialVariant={p.materialVariant} profileVariant={p.profileVariant}/>
   {p.glass!=='None' && <mesh position={[0,0,glassZ]}><planeGeometry args={[aw,ah]}/><meshPhysicalMaterial transparent opacity={p.glass==='Museum'?.07:.16} roughness={p.glass==='Museum'?.06:.19} metalness={.05} clearcoat={1}/></mesh>}
   {p.debug && <><lineSegments><edgesGeometry args={[new THREE.BoxGeometry(ow,oh,m.depthMm*mm)]}/><lineBasicMaterial color="#e3b65f"/></lineSegments><Text position={[0,-oh/2-.12,.04]} fontSize={.035} color="#d9b86f">{`${Math.round(ow/mm)} × ${Math.round(oh/mm)} mm`}</Text></>}
 </group>{!wall&&<ContactShadows position={[0,-1.1,-.2]} opacity={.45} scale={6} blur={2.5}/>}<OrbitControls key={`controls-${p.displayMode}-${p.view}-${p.wallPreset}`} target={orbitTarget} enableRotate={!wall} enablePan={!wall} screenSpacePanning={!wall} minDistance={wall?7.2:p.view==='Detail'?.42:1.05} maxDistance={wall?11:4.2} minPolarAngle={Math.PI*.36} maxPolarAngle={Math.PI*.64}/><PerspectiveCamera key={`camera-${p.displayMode}-${p.view}-${p.wallPreset}`} makeDefault position={cam as [number,number,number]} fov={wall?room.camera.fov:p.view==='Detail'?31:33}/></>;
}
export default function FramedArtwork(p:Props){return <Canvas className="canvas" shadows dpr={[1,2]}><Scene {...p}/></Canvas>}
