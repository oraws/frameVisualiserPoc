export type SupplierImage = { label:string; url:string };
export type Moulding = { sku:string; supplier:string; name:string; widthMm:number; depthMm:number; rebateMm:number; profileType:'ornate-scoop'|'flat'|'angled'; finish:string; baseColor:string; accentColor?:string; roughness:number; ornament:number; confidence:Record<string,string>; sourceUrl?:string; supplierImages?:SupplierImage[] };

const mainlineSpin=(sku:string,frames:number[]):SupplierImage[]=>frames.map(frame=>({
  label:`Rotation ${String(frame).padStart(2,'0')}`,
  url:`https://mainline-website.s3.amazonaws.com/spin_images/${sku.replace('-','')}/Images/${sku.replace('-','')}/Lv2/img${String(frame).padStart(2,'0')}.jpg`,
}));
export const mouldings:Moulding[] = [
  { sku:'POL-4875', supplier:'Mainline', name:'Verona Black', widthMm:97, depthMm:49, rebateMm:16, profileType:'ornate-scoop', finish:'ornate black polcore', baseColor:'#151515', accentColor:'#4b453c', roughness:.31, ornament:1, confidence:{shape:'Approximate',dimensions:'High',texture:'Medium',colour:'Medium',material:'Medium'}, sourceUrl:'https://mainlinemouldings.com/verona-black-97mm-polcore-moulding/', supplierImages:mainlineSpin('POL-4875',[1,12,23,34,45]) },
  { sku:'POL-4100', supplier:'Mainline', name:'Brushed Black', widthMm:41, depthMm:13, rebateMm:9, profileType:'flat', finish:'brushed black polcore', baseColor:'#151817', accentColor:'#515751', roughness:.44, ornament:.18, confidence:{shape:'Auto candidate',dimensions:'High',texture:'Medium',colour:'Medium',material:'Medium'}, sourceUrl:'https://mainlinemouldings.com/brushed-black-41mm-polcore-moulding/', supplierImages:mainlineSpin('POL-4100',[1,12,23,34,45]) },
  { sku:'4925BG', supplier:'Centrado', name:'Bergen Black & Gold Angled', widthMm:49, depthMm:25, rebateMm:10, profileType:'angled', finish:'black and gold angled', baseColor:'#11110f', accentColor:'#ad8641', roughness:.28, ornament:.55, confidence:{shape:'Medium',dimensions:'Medium',texture:'Medium',colour:'Medium',material:'Medium'}, supplierImages:[{label:'Supplier page',url:'/assets/mouldings/4925BG/source-product.jpg'}] }
];
