import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3, FloatType, ShaderChunk } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { fittedRoomFov } from '../src/renderer/generatedRoomMath.ts';
import { softenWindowShadow, windowShadowRadius } from '../src/renderer/softWindowShadow.ts';

// Test the installed bundled shader (its comments are stripped), and ensure
// softening the generated room never mutates photographic-room shader globals.
const originalShadowChunk = ShaderChunk.shadowmap_pars_fragment;
const wallShader = { fragmentShader: '#include <shadowmap_pars_fragment>' };
softenWindowShadow(wallShader);
assert.ok(wallShader.fragmentShader.includes('shadow /= totalWeight;'));
assert.equal(ShaderChunk.shadowmap_pars_fragment, originalShadowChunk);
assert.ok(windowShadowRadius(80, 6, 3) > windowShadowRadius(20, 6, 3));
assert.ok(windowShadowRadius(50, 6, 3) > windowShadowRadius(50, 6, 1));

let comparisons = 0;
for (const id of ['generated-gallery', 'sofa-gallery']) {
const root = new URL(`../public/assets/rooms/${id}/`, import.meta.url);
const scene = JSON.parse(await readFile(new URL('scene.json', root), 'utf8'));
const reference = JSON.parse(await readFile(new URL('projection.json', root), 'utf8'));
const imageAspect = scene.imageWidth / scene.imageHeight;
for (const [width, height] of [[1800,1400], [1200,800], [640,1100], [2560,1000]]) {
  for (const fit of ['contain', 'cover']) {
    const viewportAspect = width / height;
    const camera = new PerspectiveCamera(fittedRoomFov(scene.camera.fov, imageAspect, viewportAspect, fit), viewportAspect, .1, 100);
    camera.position.fromArray(scene.camera.position);
    camera.lookAt(new Vector3(...scene.camera.target));
    camera.updateMatrixWorld();
    const scale = fit === 'contain' ? Math.min(width/scene.imageWidth, height/scene.imageHeight) : Math.max(width/scene.imageWidth, height/scene.imageHeight);
    const renderedWidth = scene.imageWidth*scale, renderedHeight = scene.imageHeight*scale;
    for (const landmark of reference.landmarks) {
      const actual = new Vector3(...landmark.world).project(camera);
      const expectedX = (width-renderedWidth)/2 + landmark.image[0]*renderedWidth;
      const expectedY = (height-renderedHeight)/2 + landmark.image[1]*renderedHeight;
      assert.ok(Math.abs((actual.x+1)*width/2-expectedX) < .05, `${fit} ${width}x${height}: horizontal mismatch`);
      assert.ok(Math.abs((1-actual.y)*height/2-expectedY) < .05, `${fit} ${width}x${height}: vertical mismatch`);
      comparisons++;
    }
  }
}
const bytes = await readFile(new URL('environment.exr', root));
const environment = new EXRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
assert.equal(environment.width, 1024);
assert.equal(environment.height, 512);
assert.ok(environment.data.every(Number.isFinite), 'Environment must contain finite radiance');
assert.ok(environment.data.some(value => value > 0), 'Environment must contain usable lighting');
}
console.log(`${comparisons} Blender-to-browser landmark comparisons passed, including contain/cover and portrait layouts. EXR decoded successfully.`);
