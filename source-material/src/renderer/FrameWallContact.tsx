import { useMemo } from 'react';
import * as THREE from 'three';

/** Local ambient occlusion at the back of a wall-hung frame. The directional
 * shadow handles the outer penumbra; this short falloff anchors the back edge.
 * Kept outside the exported product: Cycles calculates this contact itself. */
export default function FrameWallContact({ matrix, width, height, wallZ, strength }: {
  matrix: THREE.Matrix4; width: number; height: number; wallZ: number; strength: number;
}) {
  const padding = .06;
  const placement = matrix.clone();
  placement.elements[14] = wallZ + .0002;
  const uniforms = useMemo(() => ({
    halfSize: { value: new THREE.Vector2(width / 2, height / 2) },
    opacity: { value: Math.min(.7, .55 * strength) },
    ink: { value: new THREE.Color('#29231c') },
  }), [width, height, strength]);
  return <mesh matrix={placement} matrixAutoUpdate={false} renderOrder={1}>
    <planeGeometry args={[width + padding * 2, height + padding * 2]} />
    <shaderMaterial transparent depthWrite={false} uniforms={uniforms}
      vertexShader={`varying vec2 localPosition;
        void main() { localPosition = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`}
      fragmentShader={`varying vec2 localPosition;
        uniform vec2 halfSize;
        uniform float opacity;
        uniform vec3 ink;
        void main() {
          vec2 outside = max(abs(localPosition) - halfSize - vec2(0.025), 0.0);
          float distanceToBack = length(outside);
          float contact = exp(-distanceToBack / 0.018);
          contact *= 1.0 - smoothstep(0.04, 0.055, distanceToBack);
          gl_FragColor = vec4(ink, opacity * contact);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`} />
  </mesh>;
}
