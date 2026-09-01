import { useEffect, useMemo, useRef, useState } from 'react';
import { roomAdminRooms, roomCalibrationKey, roomVisibilityKey, type RoomAdminDefinition } from '../renderer/roomAdminRegistry';
import { customRoomImageUrl, listCustomRooms, saveCustomRoom } from '../renderer/customRoomStore';

type Point={x:number;y:number};
type Draft={
 roomId:string;
 status:string;
 sourceDimensions:{width:number;height:number};
 geometry:{
  model:string;
  commercialDeploymentAllowed:boolean;
  device:string;
  inferenceSeconds:number;
  camera:{horizontalFovDegrees:number};
  wallHypothesis:{yawDegrees:number;pitchDegrees:number;ransacInlierFraction:number;residualP95ModelUnits:number};
 };
 manualCalibration:{quadNormalised:number[][];frameCentreNormalised?:number[];scaleReference?:{label:string;lengthMm:number;pointsNormalised:number[][]}};
 lighting:{status:string;dominantImagePoint:number[];exposureClippedFraction:number;rendererUseAllowed:boolean};
};

const defaultScaleReference={label:'Target-wall floor to ceiling',lengthMm:2400,pointsNormalised:[[.12,.18],[.12,.72]]};
type AdminRoom=RoomAdminDefinition&{draftRecord?:Draft;custom?:boolean;imageAspect?:number};

function createUploadDraft(id:string,width:number,height:number):Draft{return{
 roomId:id,status:'uploaded-awaiting-approval',sourceDimensions:{width,height},
 geometry:{model:'manual room upload seed',commercialDeploymentAllowed:true,device:'browser upload',inferenceSeconds:0,camera:{horizontalFovDegrees:55},wallHypothesis:{yawDegrees:0,pitchDegrees:0,ransacInlierFraction:.5,residualP95ModelUnits:0}},
 manualCalibration:{quadNormalised:[[.15,.18],[.85,.18],[.85,.78],[.15,.78]],frameCentreNormalised:[.5,.5],scaleReference:defaultScaleReference},
 lighting:{status:'LDR direction proxy',dominantImagePoint:[.25,.2],exposureClippedFraction:0,rendererUseAllowed:false}
};}

function homography(points:Point[]){
 const [p0,p1,p2,p3]=points;
 const dx1=p1.x-p2.x,dx2=p3.x-p2.x,dy1=p1.y-p2.y,dy2=p3.y-p2.y;
 const sx=p0.x-p1.x+p2.x-p3.x,sy=p0.y-p1.y+p2.y-p3.y;
 const denominator=dx1*dy2-dx2*dy1;
 let g=0,h=0;
 if(Math.abs(denominator)>1e-8){g=(sx*dy2-dx2*sy)/denominator;h=(dx1*sy-sx*dy1)/denominator;}
 const a=p1.x-p0.x+g*p1.x,b=p3.x-p0.x+h*p3.x,c=p0.x;
 const d=p1.y-p0.y+g*p1.y,e=p3.y-p0.y+h*p3.y,f=p0.y;
 return (u:number,v:number)=>{const q=g*u+h*v+1;return{x:(a*u+b*v+c)/q,y:(d*u+e*v+f)/q};};
}

function polyline(project:(u:number,v:number)=>Point,constant:number,vertical:boolean,steps=24){
 return Array.from({length:steps+1},(_,index)=>{
  const t=index/steps;
  const point=vertical?project(constant,t):project(t,constant);
  return `${point.x},${point.y}`;
 }).join(' ');
}

export default function RoomCalibrator(){
 const initialRoomId=new URLSearchParams(window.location.search).get('room')||'stock-pilot';
 const [roomId,setRoomId]=useState(initialRoomId);
 const [adminRooms,setAdminRooms]=useState<AdminRoom[]>(roomAdminRooms);
 const [draft,setDraft]=useState<Draft|null>(null);
 const [points,setPoints]=useState<Point[]>([]);
 const [scalePoints,setScalePoints]=useState<Point[]>([]);
 const [frameCentre,setFrameCentre]=useState<Point>({x:.5,y:.5});
 const [referenceMm,setReferenceMm]=useState(2400);
 const [active,setActive]=useState<{kind:'plane'|'scale'|'centre';index:number}|null>(null);
 const [checks,setChecks]=useState([false,false,false,false]);
 const [saved,setSaved]=useState(false);
 const [visible,setVisible]=useState(true);
 const [uploadName,setUploadName]=useState('My room');
 const [uploadSource,setUploadSource]=useState('');
 const svgRef=useRef<SVGSVGElement>(null);
 const selectedRoom=adminRooms.find(room=>room.id===roomId);
 const calibrationKey=roomCalibrationKey(roomId);

 useEffect(()=>{listCustomRooms().then(rooms=>setAdminRooms([...roomAdminRooms,...rooms.map(room=>({id:room.id,name:room.name,image:customRoomImageUrl(room),draft:'',sourceUrl:room.sourceUrl||'',credit:'Uploaded room',custom:true,imageAspect:room.width/room.height,draftRecord:createUploadDraft(room.id,room.width,room.height)}))])).catch(()=>{/* IndexedDB may be unavailable in private contexts */});},[]);

 useEffect(()=>{
  if(!selectedRoom)return;
  setDraft(null);setSaved(false);setChecks([false,false,false,false]);
  setVisible(localStorage.getItem(roomVisibilityKey(roomId))!=='false');
  window.history.replaceState({},'',`/room-calibrator/?room=${roomId}`);
  const loadRecord=selectedRoom.draftRecord?Promise.resolve(selectedRoom.draftRecord):fetch(selectedRoom.draft).then(response=>response.json());
  loadRecord.then((record:Draft)=>{
  setDraft(record);
  const stored=localStorage.getItem(calibrationKey);
  if(stored){
   try{const parsed=JSON.parse(stored);if(parsed.approved&&parsed.manualCalibration?.quadNormalised){
   setPoints(parsed.manualCalibration.quadNormalised.map(([x,y]:number[])=>({x,y})));
    const scale=parsed.manualCalibration.scaleReference||record.manualCalibration.scaleReference||defaultScaleReference;
    setScalePoints(scale.pointsNormalised.map(([x,y]:number[])=>({x,y})));
    const centre=parsed.manualCalibration.frameCentreNormalised||record.manualCalibration.frameCentreNormalised||[.5,.5];setFrameCentre({x:centre[0],y:centre[1]});
    setReferenceMm(scale.lengthMm);
    setChecks([true,true,true,true]);
    setSaved(true);
    return;
   }}catch{/* keep draft */}
  }
  setPoints(record.manualCalibration.quadNormalised.map(([x,y])=>({x,y})));
  const scale=record.manualCalibration.scaleReference||defaultScaleReference;
  setScalePoints(scale.pointsNormalised.map(([x,y])=>({x,y})));
  const centre=record.manualCalibration.frameCentreNormalised||[.5,.5];setFrameCentre({x:centre[0],y:centre[1]});
  setReferenceMm(scale.lengthMm);
 });},[roomId,adminRooms.length]);

 const project=useMemo(()=>points.length===4?homography(points):null,[points]);
 const allChecked=checks.every(Boolean);
 const pointerPoint=(event:React.PointerEvent)=>{
  const rect=svgRef.current!.getBoundingClientRect();
  return{x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
 };
 const move=(event:React.PointerEvent)=>{
 if(active===null)return;
  const next=pointerPoint(event);
  setSaved(false);
  const bounded={x:Math.max(0,Math.min(1,next.x)),y:Math.max(0,Math.min(1,next.y))};
  if(active.kind==='plane')setPoints(current=>current.map((point,index)=>index===active.index?bounded:point));
  else if(active.kind==='scale')setScalePoints(current=>current.map((point,index)=>index===active.index?bounded:point));
  else if(project){
   let closest={point:{x:.5,y:.5},distance:Infinity};
   for(let y=0;y<=1;y+=.02)for(let x=0;x<=1;x+=.02){const candidate=project(x,y),distance=Math.hypot(candidate.x-bounded.x,candidate.y-bounded.y);if(distance<closest.distance)closest={point:{x,y},distance};}
   setFrameCentre(closest.point);
  }
 };
 const approvedRecord=()=>draft&&({
  ...draft,
  status:'geometry-approved-lighting-proxy',
  approved:true,
  rendererUseAllowed:true,
  approvedAt:new Date().toISOString(),
  visibleInVisualizer:visible,
  manualCalibration:{...draft.manualCalibration,quadNormalised:points.map(point=>[Number(point.x.toFixed(6)),Number(point.y.toFixed(6))]),frameCentreNormalised:[Number(frameCentre.x.toFixed(4)),Number(frameCentre.y.toFixed(4))],scaleReference:{label:'Target-wall floor to ceiling',lengthMm:referenceMm,pointsNormalised:scalePoints.map(point=>[Number(point.x.toFixed(6)),Number(point.y.toFixed(6))])},reviewedAt:new Date().toISOString(),reviewer:'local-review'},
  renderer:{
   cameraFovDegrees:draft.geometry.camera.horizontalFovDegrees,
   wallYawDegrees:draft.geometry.wallHypothesis.yawDegrees,
   wallPitchDegrees:draft.geometry.wallHypothesis.pitchDegrees,
   quadNormalised:points.map(point=>[Number(point.x.toFixed(6)),Number(point.y.toFixed(6))]),
   lightingMode:'ldr-directional-proxy'
  }
 });
 const approveAndOpen=()=>{
  const record=approvedRecord();
  if(!record)return;
  localStorage.setItem(calibrationKey,JSON.stringify(record));
  localStorage.setItem(roomVisibilityKey(roomId),String(visible));
  setSaved(true);
  window.location.assign(`/?mode=wall&room=${roomId}`);
 };
 const reset=()=>{if(!draft)return;const scale=draft.manualCalibration.scaleReference||defaultScaleReference;const centre=draft.manualCalibration.frameCentreNormalised||[.5,.5];setPoints(draft.manualCalibration.quadNormalised.map(([x,y])=>({x,y})));setFrameCentre({x:centre[0],y:centre[1]});setScalePoints(scale.pointsNormalised.map(([x,y])=>({x,y})));setReferenceMm(scale.lengthMm);setChecks([false,false,false,false]);setSaved(false);localStorage.removeItem(calibrationKey);};
 const setRoomVisibility=(next:boolean)=>{setVisible(next);localStorage.setItem(roomVisibilityKey(roomId),String(next));const stored=localStorage.getItem(calibrationKey);if(stored)try{localStorage.setItem(calibrationKey,JSON.stringify({...JSON.parse(stored),visibleInVisualizer:next}))}catch{/* invalid record remains untouched */}};
 const uploadRoom=async(event:React.ChangeEvent<HTMLInputElement>)=>{
  const file=event.target.files?.[0];if(!file)return;
  const bitmap=await createImageBitmap(file),id=`custom-${Date.now().toString(36)}`,name=uploadName.trim()||file.name.replace(/\.[^.]+$/,'')||'My room',record={id,name,image:file,width:bitmap.width,height:bitmap.height,sourceUrl:uploadSource.trim(),createdAt:new Date().toISOString()};
  bitmap.close();await saveCustomRoom(record);
  const room:AdminRoom={id,name,image:customRoomImageUrl(record),draft:'',sourceUrl:'',credit:'Uploaded room',custom:true,imageAspect:record.width/record.height,draftRecord:createUploadDraft(id,record.width,record.height)};
  setAdminRooms(current=>[...current,room]);setRoomId(id);setUploadSource('');event.target.value='';
 };

 if(!selectedRoom||!draft||!project)return <main className="cal-loading">Loading reconstruction evidence…</main>;
 return <main className="cal-app">
  <section className="cal-workspace">
   <div className="cal-brand">ADMIN / ROOM CALIBRATION<span>{selectedRoom.name.toUpperCase()} · CALIBRATION DRAFT + MANUAL PROOF</span></div>
   <div className="cal-image-wrap">
    <img src={selectedRoom.image} alt={`${selectedRoom.name} selected for camera, wall and lighting calibration`}/>
    <svg ref={svgRef} viewBox="0 0 1 1" preserveAspectRatio="none" onPointerMove={move} onPointerUp={()=>setActive(null)} onPointerCancel={()=>setActive(null)}>
     {Array.from({length:9},(_,i)=>i/8).map(value=><polyline key={`v-${value}`} points={polyline(project,value,true)} className={value===0||value===1?'grid-edge':'grid-line'} vectorEffect="non-scaling-stroke"/>)}
     {Array.from({length:7},(_,i)=>i/6).map(value=><polyline key={`h-${value}`} points={polyline(project,value,false)} className={value===0||value===1?'grid-edge':'grid-line'} vectorEffect="non-scaling-stroke"/>)}
     <polygon points={[project(frameCentre.x-.4,frameCentre.y-.4),project(frameCentre.x+.4,frameCentre.y-.4),project(frameCentre.x+.4,frameCentre.y+.4),project(frameCentre.x-.4,frameCentre.y+.4)].map(p=>`${p.x},${p.y}`).join(' ')} className="frame-proxy" vectorEffect="non-scaling-stroke"/>
     <polygon points={[project(frameCentre.x-.34,frameCentre.y-.34),project(frameCentre.x+.34,frameCentre.y-.34),project(frameCentre.x+.34,frameCentre.y+.34),project(frameCentre.x-.34,frameCentre.y+.34)].map(p=>`${p.x},${p.y}`).join(' ')} className="mount-proxy" vectorEffect="non-scaling-stroke"/>
     {scalePoints.length===2&&<line x1={scalePoints[0].x} y1={scalePoints[0].y} x2={scalePoints[1].x} y2={scalePoints[1].y} className="scale-reference" vectorEffect="non-scaling-stroke"/>}
     {scalePoints.map((point,index)=><circle key={`scale-${index}`} cx={point.x} cy={point.y} r=".009" className="scale-handle" vectorEffect="non-scaling-stroke" onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);setActive({kind:'scale',index});}}/>)}
     {points.map((point,index)=><circle key={index} cx={point.x} cy={point.y} r=".011" className="grid-handle" vectorEffect="non-scaling-stroke" onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);setActive({kind:'plane',index});}}/>)}
     <circle cx={project(frameCentre.x,frameCentre.y).x} cy={project(frameCentre.x,frameCentre.y).y} r=".012" className="centre-handle" vectorEffect="non-scaling-stroke" onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);setActive({kind:'centre',index:0});}}/>
    </svg>
   </div>
   <div className="cal-caption"><b>Gold: perspective · cyan: physical scale · pink: frame centre.</b> Drag the pink handle to choose a natural position on the wall plane.</div>
  </section>
  <aside className="cal-panel">
   <nav className="cal-nav"><a href="/">Viewer</a><span>Room admin</span></nav>
   <h1>Wall-plane review</h1>
   <p>The automatic result is a proposal. It cannot enter the room list until this visual check is approved.</p>
   <section className="cal-intake"><h2>Add a room image</h2><p>Choose a rights-cleared photograph with a large visible wall and strong architectural lines. <a href="https://www.pexels.com/license/" target="_blank" rel="noreferrer">Pexels licence</a> · <a href="https://unsplash.com/license" target="_blank" rel="noreferrer">Unsplash licence</a></p><div className="cal-stock-links"><a href="https://www.pexels.com/search/interior%20blank%20wall/" target="_blank" rel="noreferrer">Browse Pexels ↗</a><a href="https://unsplash.com/s/photos/interior-blank-wall" target="_blank" rel="noreferrer">Browse Unsplash ↗</a></div><label><span>Room name</span><input value={uploadName} onChange={event=>setUploadName(event.target.value)}/></label><label><span>Source page URL (recommended)</span><input type="url" placeholder="https://…" value={uploadSource} onChange={event=>setUploadSource(event.target.value)}/></label><label className="cal-upload"><span>Upload downloaded image</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadRoom}/></label></section>
   <label className="cal-room-picker"><span>Room draft</span><select value={roomId} onChange={event=>setRoomId(event.target.value)}>{adminRooms.map(room=><option value={room.id} key={room.id}>{room.name}{room.custom?' · uploaded':''}</option>)}</select></label>
   {selectedRoom.sourceUrl&&<p className="cal-source"><a href={selectedRoom.sourceUrl} target="_blank" rel="noreferrer">{selectedRoom.credit} ↗</a></p>}
   <div className="cal-status"><span>{saved?'Admin approved':'Approval required'}</span><b>{draft.geometry.inferenceSeconds?`${draft.geometry.inferenceSeconds.toFixed(2)}s CPU inference`:'Manual seed'}</b></div>
   <dl>
    <div><dt>Geometry</dt><dd>{draft.geometry.model}</dd></div>
    <div><dt>Camera FOV</dt><dd>{draft.geometry.camera.horizontalFovDegrees.toFixed(1)}°</dd></div>
    <div><dt>Wall normal</dt><dd>{draft.geometry.wallHypothesis.yawDegrees.toFixed(1)}° yaw · {draft.geometry.wallHypothesis.pitchDegrees.toFixed(1)}° pitch</dd></div>
    <div><dt>Plane inliers</dt><dd>{Math.round(draft.geometry.wallHypothesis.ransacInlierFraction*100)}%</dd></div>
    <div><dt>Lighting</dt><dd>LDR direction proxy only</dd></div>
   </dl>
   <section className="cal-scale"><h2>Physical scale</h2><p>The cyan handles span floor to ceiling on this wall.</p><label><span>Known distance</span><input type="number" min="500" max="6000" step="10" value={referenceMm} onChange={event=>{setReferenceMm(Number(event.target.value));setSaved(false)}}/><b>mm</b></label></section>
   <label className="cal-visibility"><input type="checkbox" checked={visible} onChange={event=>setRoomVisibility(event.target.checked)}/><span><b>Show in visualiser</b><small>Turn this off to retain the calibration in Room Admin without offering the room to viewers.</small></span></label>
   {roomId==='stock-pilot'?<div className="cal-evidence"><figure><img src="/assets/rooms/stock-pilot/calibration/depth-diagnostic.png"/><figcaption>Predicted depth + wall ROI</figcaption></figure><figure><img src="/assets/rooms/stock-pilot/calibration/confidence-diagnostic.png"/><figcaption>Model confidence</figcaption></figure></div>:<div className="cal-warning"><b>New room draft</b><span>The initial grid follows visible architectural lines. Adjust the gold plane and cyan physical reference before approval.</span></div>}
   <section className="cal-checks"><h2>Approval checks</h2>{[
    'Grid lines agree with the ceiling, skirting and door edges',
    'Reference proxy looks vertical and physically attached',
    'Observed ceiling and ambient light direction matches the photograph',
    'Cyan scale reference spans the known floor-to-ceiling distance'
   ].map((label,index)=><label key={label}><input type="checkbox" checked={checks[index]} onChange={event=>setChecks(current=>current.map((value,i)=>i===index?event.target.checked:value))}/><span>{label}</span></label>)}</section>
   <button className="cal-approve" disabled={!allChecked&&!saved} onClick={approveAndOpen}>{saved?'Open approved room in visualiser':'Approve and add to visualiser'}</button>
   <p className="cal-save-note">For this POC the approved room is saved inside this browser. The production app will persist the same record through the admin API and database.</p>
   <button className="cal-reset" onClick={reset}>Reset to automatic draft</button>
   <div className="cal-warning"><b>Deliberate limitation</b><span>The JPEG has {(draft.lighting.exposureClippedFraction*100).toFixed(1)}% clipped highlights, so exact HDR radiance cannot be recovered. This pilot uses the observed bright-region direction as a soft-light proxy.</span></div>
  </aside>
 </main>;
}
