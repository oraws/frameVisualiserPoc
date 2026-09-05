export type RoomAdminDefinition={
 id:string;
 name:string;
 image:string;
 draft:string;
 sourceUrl:string;
 credit:string;
};

export const roomAdminRooms:RoomAdminDefinition[]=[
 {id:'stock-pilot',name:'Calibrated Test Room',image:'/assets/rooms/stock-pilot/room.jpg',draft:'/assets/rooms/stock-pilot/calibration/calibration-draft.json',sourceUrl:'',credit:'Existing calibration pilot'},
 {id:'warm-minimal-bedroom',name:'Warm Minimal Bedroom',image:'/assets/rooms/warm-minimal-bedroom/room.jpg',draft:'/assets/rooms/warm-minimal-bedroom/calibration/calibration-draft.json',sourceUrl:'https://www.pexels.com/photo/modern-empty-bedroom-with-king-size-bed-6489082/',credit:'Photo by Max Vakhtbovych · Pexels'},
 {id:'panelled-white-salon',name:'Panelled White Salon',image:'/assets/rooms/panelled-white-salon/room.jpg',draft:'/assets/rooms/panelled-white-salon/calibration/calibration-draft.json',sourceUrl:'https://www.pexels.com/photo/white-sofa-beside-white-wall-8581013/',credit:'Photo by RDNE Stock project · Pexels'},
 {id:'white-gallery-corridor',name:'White Gallery Corridor',image:'/assets/rooms/white-gallery-corridor/room.jpg',draft:'/assets/rooms/white-gallery-corridor/calibration/calibration-draft.json',sourceUrl:'https://www.pexels.com/photo/sofa-in-the-living-room-with-white-walls-7195886/',credit:'Photo by Max Vakhtbovych · Pexels'},
 {id:'oblique-gallery-wall',name:'Oblique Gallery Wall',image:'/assets/rooms/oblique-gallery-wall.png',draft:'/assets/rooms/oblique-gallery-wall/calibration/calibration-draft.json',sourceUrl:'',credit:'Generated photographic room asset'},
 {id:'neutral-gallery-wall',name:'Neutral Gallery Wall',image:'/assets/rooms/neutral-gallery-wall.png',draft:'/assets/rooms/neutral-gallery-wall/calibration/calibration-draft.json',sourceUrl:'',credit:'Generated photographic room asset'},
 {id:'warm-living-room',name:'Warm Living Room',image:'/assets/rooms/warm-living-room.png',draft:'/assets/rooms/warm-living-room/calibration/calibration-draft.json',sourceUrl:'',credit:'Generated photographic room asset'},
 {id:'british-fireplace',name:'British Fireplace',image:'/assets/rooms/british-fireplace-room.png',draft:'/assets/rooms/british-fireplace/calibration/calibration-draft.json',sourceUrl:'',credit:'Generated photographic room asset'},
 {id:'modern-dining-room',name:'Modern Dining Room',image:'/assets/rooms/modern-dining-room.png',draft:'/assets/rooms/modern-dining-room/calibration/calibration-draft.json',sourceUrl:'',credit:'Generated photographic room asset'},
];

export const roomAdminById=(id:string)=>roomAdminRooms.find(room=>room.id===id)||roomAdminRooms[0];
export const roomCalibrationKey=(id:string)=>`room-calibration:${id}`;
export const roomPreviewKey=(id:string)=>`room-preview:${id}`;
export const roomVisibilityKey=(id:string)=>`room-visibility:${id}`;
