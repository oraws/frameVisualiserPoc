import sofaGallery from '../../public/assets/rooms/sofa-gallery/scene.json';
import generatedGallery from '../../public/assets/rooms/generated-gallery/scene.json';

export type RoomTemplate={
 kind?: 'photograph' | 'generated';
 sceneId?: string;
 calibrationId?:string;
 image:string;
 imageAspect?:number;
 imageAnchorX?:'left'|'center';
 framePosition:[number,number,number];
 frameScale:number;
 frameRotation:[number,number,number];
 camera:{position:[number,number,number];fov:number;target?:[number,number,number]};
 keyLight:{position:[number,number,number];intensity:number;color:string};
 ambient:number;
 environment:number;
 shadow:{opacity:number;color:string;bias:number;radius:number};
 tintOpacity:number;
 angleLabel:string;
 calibrationStatus:'approved-local'|'unverified'|'legacy';
};

export const roomPresets:Record<string,RoomTemplate>={
 [generatedGallery.name]:{
   kind:'generated', sceneId:generatedGallery.id,
   image:generatedGallery.image, imageAspect:generatedGallery.imageWidth/generatedGallery.imageHeight,
   framePosition:generatedGallery.framePosition as [number,number,number], frameScale:1, frameRotation:[0,0,0],
   camera:{position:generatedGallery.camera.position as [number,number,number],fov:generatedGallery.camera.fov,target:generatedGallery.camera.target as [number,number,number]},
   keyLight:{position:generatedGallery.keyLight.position as [number,number,number],intensity:generatedGallery.keyLight.intensity,color:generatedGallery.keyLight.color},
   ambient:generatedGallery.fill,environment:generatedGallery.environmentIntensity,
   shadow:{opacity:.32,color:'#302920',bias:-.00005,radius:4},
   tintOpacity:0,angleLabel:'Fixed camera · scene-defined light',calibrationStatus:'approved-local',
 },
 'AI Enhanced · Linen Sofa Gallery':{
   kind:'generated', sceneId:sofaGallery.id,
   image:'/assets/rooms/sofa-gallery/room-ai-enhanced.png', imageAspect:sofaGallery.imageWidth/sofaGallery.imageHeight,
   framePosition:sofaGallery.framePosition as [number,number,number], frameScale:1, frameRotation:[0,0,0],
   camera:{position:sofaGallery.camera.position as [number,number,number],fov:sofaGallery.camera.fov,target:sofaGallery.camera.target as [number,number,number]},
   keyLight:{position:sofaGallery.keyLight.position as [number,number,number],intensity:sofaGallery.keyLight.intensity,color:sofaGallery.keyLight.color},
   ambient:sofaGallery.fill,environment:sofaGallery.environmentIntensity,
   shadow:{opacity:.32,color:'#302920',bias:-.00005,radius:4},
   tintOpacity:0,angleLabel:'AI-enhanced room · fixed 3D camera and light',calibrationStatus:'approved-local',
 },
 [sofaGallery.name]:{
   kind:'generated', sceneId:sofaGallery.id,
   image:sofaGallery.image, imageAspect:sofaGallery.imageWidth/sofaGallery.imageHeight,
   framePosition:sofaGallery.framePosition as [number,number,number], frameScale:1, frameRotation:[0,0,0],
   camera:{position:sofaGallery.camera.position as [number,number,number],fov:sofaGallery.camera.fov,target:sofaGallery.camera.target as [number,number,number]},
   keyLight:{position:sofaGallery.keyLight.position as [number,number,number],intensity:sofaGallery.keyLight.intensity,color:sofaGallery.keyLight.color},
   ambient:sofaGallery.fill,environment:sofaGallery.environmentIntensity,
   shadow:{opacity:.32,color:'#302920',bias:-.00005,radius:4},
   tintOpacity:0,angleLabel:'Fixed camera · scene-defined light',calibrationStatus:'approved-local',
 },
 'Calibrated Test Room':{calibrationId:'stock-pilot',image:'/assets/rooms/stock-pilot/room.jpg',imageAspect:2600/1733,imageAnchorX:'left',framePosition:[-2.18,-.28,0],frameScale:.98,frameRotation:[.0073,.8064,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-3.4,4.8,4.6],intensity:1.76,color:'#f2e6cf'},ambient:.78,environment:.44,shadow:{opacity:.14,color:'#615b52',bias:-.00018,radius:12},tintOpacity:.025,angleLabel:'Admin-calibrated wall',calibrationStatus:'approved-local'},
 'Warm Minimal Bedroom':{calibrationId:'warm-minimal-bedroom',image:'/assets/rooms/warm-minimal-bedroom/room.jpg',imageAspect:2400/1602,imageAnchorX:'center',framePosition:[0,.2,0],frameScale:.8,frameRotation:[0,0,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-4,4,5],intensity:1.65,color:'#f7ead9'},ambient:.76,environment:.45,shadow:{opacity:.2,color:'#53483d',bias:-.00018,radius:12},tintOpacity:.025,angleLabel:'Awaiting admin calibration',calibrationStatus:'approved-local'},
 'Panelled White Salon':{calibrationId:'panelled-white-salon',image:'/assets/rooms/panelled-white-salon/room.jpg',imageAspect:2400/3600,imageAnchorX:'center',framePosition:[0,.2,0],frameScale:.8,frameRotation:[0,0,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-4,4,5],intensity:1.7,color:'#f3eee5'},ambient:.8,environment:.46,shadow:{opacity:.18,color:'#514d46',bias:-.00018,radius:12},tintOpacity:.02,angleLabel:'Awaiting admin calibration',calibrationStatus:'approved-local'},
 'White Gallery Corridor':{calibrationId:'white-gallery-corridor',image:'/assets/rooms/white-gallery-corridor/room.jpg',imageAspect:2400/1602,imageAnchorX:'left',framePosition:[0,.2,0],frameScale:.8,frameRotation:[0,0,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-4,4,5],intensity:1.75,color:'#fff4e2'},ambient:.78,environment:.44,shadow:{opacity:.2,color:'#554b40',bias:-.00018,radius:12},tintOpacity:.02,angleLabel:'Awaiting admin calibration',calibrationStatus:'approved-local'},
 'Oblique Gallery Wall':{calibrationId:'oblique-gallery-wall',image:'/assets/rooms/oblique-gallery-wall.png',imageAspect:1672/941,imageAnchorX:'center',framePosition:[-.88,.56,0],frameScale:.76,frameRotation:[0,.56,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-4.8,3.4,5.8],intensity:2.15,color:'#fff2dc'},ambient:.72,environment:.5,shadow:{opacity:.36,color:'#44372d',bias:-.00018,radius:8},tintOpacity:.07,angleLabel:'Hand-estimated 32°',calibrationStatus:'unverified'},
 'Neutral Gallery Wall':{calibrationId:'neutral-gallery-wall',image:'/assets/rooms/neutral-gallery-wall.png',imageAspect:1672/941,imageAnchorX:'center',framePosition:[.26,.58,0],frameScale:.7,frameRotation:[0,.22,-.008],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-4.2,3.2,5.4],intensity:1.95,color:'#fff0dc'},ambient:.7,environment:.46,shadow:{opacity:.32,color:'#45372c',bias:-.00018,radius:8},tintOpacity:.07,angleLabel:'Hand-estimated 13°',calibrationStatus:'unverified'},
 'Warm Living Room':{calibrationId:'warm-living-room',image:'/assets/rooms/warm-living-room.png',imageAspect:1672/941,imageAnchorX:'center',framePosition:[.2,.72,0],frameScale:.78,frameRotation:[0,0,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-4,3.4,5.2],intensity:1.72,color:'#fff0d8'},ambient:.66,environment:.4,shadow:{opacity:.3,color:'#3d3128',bias:-.00018,radius:8},tintOpacity:.08,angleLabel:'Front-wall assumption',calibrationStatus:'legacy'},
 'British Fireplace':{calibrationId:'british-fireplace',image:'/assets/rooms/british-fireplace-room.png',imageAspect:1672/941,imageAnchorX:'center',framePosition:[-.68,.42,0],frameScale:.58,frameRotation:[0,0,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-3.8,3.2,5],intensity:1.66,color:'#f1ede2'},ambient:.64,environment:.38,shadow:{opacity:.28,color:'#37332e',bias:-.00018,radius:8},tintOpacity:.08,angleLabel:'Front-wall assumption',calibrationStatus:'legacy'},
 'Modern Dining Room':{calibrationId:'modern-dining-room',image:'/assets/rooms/modern-dining-room.png',imageAspect:1672/941,imageAnchorX:'center',framePosition:[-.2,.72,0],frameScale:.72,frameRotation:[0,0,0],camera:{position:[0,.1,9.2],fov:36},keyLight:{position:[-4.5,3.5,5.4],intensity:1.88,color:'#fff1dc'},ambient:.68,environment:.42,shadow:{opacity:.31,color:'#40362d',bias:-.00018,radius:8},tintOpacity:.08,angleLabel:'Front-wall assumption',calibrationStatus:'legacy'},
};

export const roomPresetNames=Object.keys(roomPresets);
export const fallbackRoom=roomPresets['Oblique Gallery Wall'];

export const generatedScenes: Record<string, typeof generatedGallery> = { [generatedGallery.id]: generatedGallery, [sofaGallery.id]: sofaGallery };
