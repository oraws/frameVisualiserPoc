import invoiceMouldings from './invoiceMouldings.json';
import centradoMouldings from './centradoMouldings.json';
import familyReferenceManifest from './familyReferences.json';

export type SupplierImage = { label:string; url:string; kind?:'product'|'family'; family?:string };
export type Moulding = { sku:string; supplier:string; supplierCode?:string; name:string; description?:string; widthMm:number; depthMm:number; rebateMm:number; profileType:'ornate-scoop'|'flat'|'angled'|'scoop'|'reverse'|'cushion'|'l-shape'; finish:string; baseColor:string; accentColor?:string; accentWidthMm?:number; colourTags?:string[]; roughness:number; ornament:number; renderStatus?:'approved'|'auto-candidate'|'supplier-reference'; discontinued?:boolean; confidence:Record<string,string>; sourceUrl?:string; supplierImages?:SupplierImage[] };

export const mouldingSupplierCode=(moulding:Moulding)=>moulding.supplierCode||({Mainline:'MNL',Centrado:'CTR'}[moulding.supplier]||moulding.supplier.slice(0,3).toUpperCase());

const mainlineSpin=(sku:string,frames:number[]):SupplierImage[]=>frames.map(frame=>({
  label:`Rotation ${String(frame).padStart(2,'0')}`,
  url:`https://mainline-website.s3.amazonaws.com/spin_images/${sku.replace('-','')}/Images/${sku.replace('-','')}/Lv2/img${String(frame).padStart(2,'0')}.jpg`,
}));
const catalogueMouldings:Moulding[] = [
  { sku:'POL-4875', supplier:'Mainline', supplierCode:'MNL', name:'Verona Black', widthMm:97, depthMm:49, rebateMm:16, profileType:'ornate-scoop', finish:'ornate black polcore', baseColor:'#151515', accentColor:'#4b453c', colourTags:['black'], roughness:.31, ornament:1, confidence:{shape:'Approximate',dimensions:'High',texture:'Medium',colour:'Medium',material:'Medium'}, sourceUrl:'https://mainlinemouldings.com/verona-black-97mm-polcore-moulding/', supplierImages:mainlineSpin('POL-4875',[1,12,23,34,45]) },
  { sku:'POL-4100', supplier:'Mainline', name:'Brushed Black', widthMm:41, depthMm:13, rebateMm:9, profileType:'flat', finish:'brushed black polcore', baseColor:'#151817', accentColor:'#515751', roughness:.44, ornament:.18, confidence:{shape:'Auto candidate',dimensions:'High',texture:'Medium',colour:'Medium',material:'Medium'}, sourceUrl:'https://mainlinemouldings.com/brushed-black-41mm-polcore-moulding/', supplierImages:mainlineSpin('POL-4100',[1,12,23,34,45]) },
  { sku:'POL-4508', supplier:'Mainline', name:'Paramount Black & Silver', widthMm:30, depthMm:30, rebateMm:13, profileType:'flat', finish:'30 mm brushed black with shaped silver sight edge', baseColor:'#151716', accentColor:'#c5c2b9', accentWidthMm:9.5, roughness:.78, ornament:.08, confidence:{shape:'Photo-calibrated candidate',dimensions:'High',texture:'Experimental',colour:'Photo reference',material:'Experimental'}, sourceUrl:'https://mainlinemouldings.com/paramount-black-sse-30mm-polcore-moulding/', supplierImages:mainlineSpin('POL-4508',[1,12,23,34,45]) },
  { sku:'POL-4418', supplier:'Mainline', name:'Flat Bronze', widthMm:54, depthMm:20, rebateMm:14, profileType:'flat', finish:'brushed bronze polcore', baseColor:'#5c4c3a', roughness:.64, ornament:.08, confidence:{shape:'Auto candidate',dimensions:'High',texture:'Experimental',colour:'Experimental',material:'Experimental'}, sourceUrl:'https://mainlinemouldings.com/54mm-flat-bronze-polcore-moulding/', supplierImages:mainlineSpin('POL-4418',[1,12,23,34,45]) },
  { sku:'POL-4211', supplier:'Mainline', name:'Flat Oak', widthMm:54, depthMm:20, rebateMm:14, profileType:'flat', finish:'brushed oak polcore', baseColor:'#a77b47', roughness:.76, ornament:.08, confidence:{shape:'Auto candidate',dimensions:'High',texture:'Experimental',colour:'Experimental',material:'Experimental'}, sourceUrl:'https://mainlinemouldings.com/54mm-flat-oak-polcore-moulding/', supplierImages:mainlineSpin('POL-4211',[1,12,23,34,45]) },
  ...(centradoMouldings as unknown as Moulding[]),
  ...(invoiceMouldings as Moulding[])
];

const familyReferences = familyReferenceManifest.bySku as Record<string, SupplierImage[]>;

export const mouldings:Moulding[] = catalogueMouldings.map((moulding) => {
  const existing = moulding.supplierImages || [];
  const additions = (familyReferences[moulding.sku] || []).filter(
    (reference) => !existing.some((image) => image.url === reference.url),
  );
  return additions.length
    ? { ...moulding, supplierImages: [...existing, ...additions] }
    : moulding;
});
