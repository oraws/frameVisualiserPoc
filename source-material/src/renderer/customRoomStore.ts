export type CustomRoomAsset={
 id:string;
 name:string;
 image:Blob;
 width:number;
 height:number;
 sourceUrl?:string;
 createdAt:string;
};

const databaseName='frame-visualiser-room-assets';
const storeName='rooms';

function openDatabase(){
 return new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open(databaseName,1);
  request.onupgradeneeded=()=>request.result.createObjectStore(storeName,{keyPath:'id'});
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
}

export async function listCustomRooms(){
 const db=await openDatabase();
 return new Promise<CustomRoomAsset[]>((resolve,reject)=>{
  const request=db.transaction(storeName,'readonly').objectStore(storeName).getAll();
  request.onsuccess=()=>resolve(request.result as CustomRoomAsset[]);
  request.onerror=()=>reject(request.error);
 });
}

export async function saveCustomRoom(room:CustomRoomAsset){
 const db=await openDatabase();
 return new Promise<void>((resolve,reject)=>{
  const request=db.transaction(storeName,'readwrite').objectStore(storeName).put(room);
  request.onsuccess=()=>resolve();
  request.onerror=()=>reject(request.error);
 });
}

export const customRoomImageUrl=(room:CustomRoomAsset)=>URL.createObjectURL(room.image);
