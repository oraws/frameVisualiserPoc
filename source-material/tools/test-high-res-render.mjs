import assert from 'node:assert/strict';
import { validatePayload } from './high-res-render/plugin.mjs';
function payload(model = {asset:{version:'2.0'},buffers:[{byteLength:0}]}) {
  let json = JSON.stringify(model); json += ' '.repeat((4-json.length%4)%4);
  const glb=Buffer.alloc(20+json.length); glb.writeUInt32LE(0x46546c67,0); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8); glb.writeUInt32LE(json.length,12); glb.writeUInt32LE(0x4e4f534a,16); glb.write(json,20);
  return {roomId:'sofa-gallery',artworkColourMode:'Source colours',glass:'None',glb:glb.toString('base64')};
}
assert.ok(validatePayload(payload()).length>20);
assert.throws(()=>validatePayload({...payload(),roomId:'../../private'}));
assert.throws(()=>validatePayload({...payload(),glass:'custom'}));
assert.throws(()=>validatePayload({...payload(),glb:'not a glb'}));
assert.throws(()=>validatePayload(payload({images:[{uri:'file:///private/example.png'}]})));
assert.throws(()=>validatePayload(payload({buffers:[{uri:'https://example.com/asset.bin'}]})));
console.log('Render validation rejects invalid rooms, malformed geometry and external assets.');
