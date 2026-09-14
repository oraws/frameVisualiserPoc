import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

function canvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Left-side cast from right-hand daylight. Its outer edge opens towards the
 * floor as the frame moves away from the wall; its inner edge stays hidden
 * beneath the frame. Keeping this separate from the product silhouette avoids
 * a false halo on the illuminated right edge. */
function sideCast(tight: boolean) {
  return canvasTexture(1024, 1024, context => {
    context.clearRect(0, 0, 1024, 1024);
    context.filter = `blur(${tight ? 22 : 38}px)`;
    context.fillStyle = tight ? 'rgba(255,255,255,.66)' : 'rgba(255,255,255,.76)';
    const margin = tight ? 72 : 72;
    // At the top the frame is against the wall, so the cast has no visible
    // width. It opens continuously towards the floor as the frame leans out.
    const topOuter = 1024 - margin;
    context.beginPath();
    context.moveTo(topOuter, margin);
    context.lineTo(1024 - margin, margin);
    context.lineTo(1024 - margin, 1024 - margin);
    context.lineTo(margin, 1024 - margin);
    context.closePath();
    context.fill();
  });
}

function floorSpread() {
  return canvasTexture(1024, 256, context => {
    context.clearRect(0, 0, 1024, 256);
    // Fade to transparent before every texture boundary. The previous radial
    // ramp retained alpha at the short edges, exposing the rectangular plane.
    const vertical = context.createLinearGradient(0, 0, 0, 256);
    vertical.addColorStop(0, 'rgba(255,255,255,0)');
    vertical.addColorStop(.18, 'rgba(255,255,255,.45)');
    vertical.addColorStop(.38, 'rgba(255,255,255,.9)');
    vertical.addColorStop(.55, 'rgba(255,255,255,.62)');
    vertical.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = vertical;
    context.fillRect(0, 0, 1024, 256);
    context.globalCompositeOperation = 'destination-in';
    const horizontal = context.createLinearGradient(0, 0, 1024, 0);
    horizontal.addColorStop(0, 'rgba(255,255,255,0)');
    horizontal.addColorStop(.1, 'rgba(255,255,255,.78)');
    horizontal.addColorStop(.25, 'rgba(255,255,255,1)');
    horizontal.addColorStop(.82, 'rgba(255,255,255,1)');
    horizontal.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = horizontal;
    context.fillRect(0, 0, 1024, 256);
  });
}

function railContact() {
  return canvasTexture(1024, 128, context => {
    context.clearRect(0, 0, 1024, 128);
    context.filter = 'blur(7px)';
    const gradient = context.createLinearGradient(0, 25, 0, 105);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(.42, 'rgba(255,255,255,.9)');
    gradient.addColorStop(.56, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(36, 25, 952, 80);
  });
}

function topContact() {
  return canvasTexture(1024, 128, context => {
    context.clearRect(0, 0, 1024, 128);
    context.filter = 'blur(7px)';
    const vertical = context.createLinearGradient(0, 0, 0, 128);
    vertical.addColorStop(0, 'rgba(255,255,255,0)');
    vertical.addColorStop(.3, 'rgba(255,255,255,.92)');
    vertical.addColorStop(.52, 'rgba(255,255,255,.7)');
    vertical.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = vertical;
    context.fillRect(30, 8, 930, 112);
  });
}

export default function LeaningFrameShadow({ matrix, width, height, wallZ, floorY, strength }: {
  matrix: THREE.Matrix4;
  width: number;
  height: number;
  wallZ: number;
  floorY: number;
  strength: number;
}) {
  const centre = new THREE.Vector3().setFromMatrixPosition(matrix);
  const scale = new THREE.Vector3().setFromMatrixColumn(matrix, 0).length();
  const axisY = new THREE.Vector3().setFromMatrixColumn(matrix, 1);
  const worldWidth = width * scale;
  const projectedHeight = Math.abs(axisY.y) * height;
  const standOff = Math.abs(axisY.z) * height;
  const bottomZ = centre.z + standOff / 2;
  const leftEdge = centre.x - worldWidth / 2;
  const shadowHeight = projectedHeight + Math.max(.1, standOff * .45);
  const softReach = Math.max(.16, standOff * 1.18);
  const tightReach = Math.max(.055, standOff * .3);
  const overlap = .022;
  // The photograph is behind the 3D wall plane. Move the wall cast slightly
  // lower to meet the photographed skirting/floor junction in screen space.
  const wallShadowFloorY = floorY - .22;
  const wallShadowY = wallShadowFloorY + shadowHeight / 2 + .003;
  const topY = centre.y + projectedHeight / 2;
  const softTexture = useMemo(() => sideCast(false), []);
  const edgeTexture = useMemo(() => sideCast(true), []);
  const floorTexture = useMemo(floorSpread, []);
  const railTexture = useMemo(railContact, []);
  const topTexture = useMemo(topContact, []);
  useEffect(() => () => {
    softTexture.dispose();
    edgeTexture.dispose();
    floorTexture.dispose();
    railTexture.dispose();
    topTexture.dispose();
  }, [softTexture, edgeTexture, floorTexture, railTexture, topTexture]);

  return <group name="reference-matched-leaning-shadow">
    <mesh position={[leftEdge - softReach / 2 + overlap / 2, wallShadowY, wallZ + .0015]} renderOrder={-3}>
      <planeGeometry args={[softReach + overlap, shadowHeight]} />
      <meshBasicMaterial map={softTexture} color="#55483f" transparent
        opacity={Math.min(.66, .52 * strength)} depthWrite={false} toneMapped={false} />
    </mesh>
    <mesh position={[leftEdge - tightReach / 2 + overlap / 2, wallShadowY, wallZ + .002]} renderOrder={-2}>
      <planeGeometry args={[tightReach + overlap, shadowHeight]} />
      <meshBasicMaterial map={edgeTexture} color="#3d332d" transparent
        opacity={Math.min(.36, .24 * strength)} depthWrite={false} toneMapped={false} />
    </mesh>
    <mesh position={[centre.x - .018, topY - .026, wallZ + .0025]} renderOrder={-1.5}>
      <planeGeometry args={[worldWidth + .045, .085]} />
      <meshBasicMaterial map={topTexture} color="#332923" transparent
        opacity={Math.min(.48, .38 * strength)} depthWrite={false} toneMapped={false} />
    </mesh>
    <mesh position={[centre.x - .055, floorY + .005, Math.max(.035, bottomZ + .015)]}
      rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
      <planeGeometry args={[worldWidth + .3, Math.min(.78, .32 + standOff * 2.25)]} />
      <meshBasicMaterial map={floorTexture} color="#3d2c23" transparent
        opacity={Math.min(.6, .5 * strength)} depthTest={false} depthWrite={false} toneMapped={false} />
    </mesh>
    <mesh position={[centre.x - .008, floorY + .006, Math.max(.04, bottomZ + .015)]}
      rotation={[-Math.PI / 2, 0, 0]} renderOrder={-.5}>
      <planeGeometry args={[worldWidth + .035, .062]} />
      <meshBasicMaterial map={railTexture} color="#211a16" transparent
        opacity={Math.min(.76, .64 * strength)} depthTest={false} depthWrite={false} toneMapped={false} />
    </mesh>
  </group>;
}
