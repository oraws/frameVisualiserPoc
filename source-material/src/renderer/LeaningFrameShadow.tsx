import { useMemo } from 'react';
import * as THREE from 'three';

const wallVertexShader = `
  varying vec3 vWorldPosition;
  void main() {
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const wallFragmentShader = `
  varying vec3 vWorldPosition;
  uniform vec2 uFrameTopLeft;
  uniform float uFloorY;
  uniform float uWallFloorY;
  uniform float uTopReach;
  uniform float uFloorReach;
  uniform float uTightSoftness;
  uniform float uBroadSoftness;
  uniform float uOpacity;
  uniform vec3 uColor;

  void main() {
    float x = vWorldPosition.x;
    float y = vWorldPosition.y;

    // Linear progress from top of frame (0.0) down to floor (1.0)
    float v = clamp((uFrameTopLeft.y - y) / max(0.01, uFrameTopLeft.y - uWallFloorY), 0.0, 1.0);

    // Continuous linear reach and softness scaling with physical standoff
    float currentReach = mix(uTopReach, uFloorReach, v);
    float currentSoftness = mix(uTightSoftness, uBroadSoftness, pow(v, 0.85));

    // Distance to the left of the frame's left edge
    float d = uFrameTopLeft.x - x;

    // Top cutoff: under daylight from upper-right, shadow slopes down-left from the top-left corner.
    // It NEVER extends above the top rail.
    float topBoundaryY = uFrameTopLeft.y - max(0.0, d) * 0.70;
    float topFade = smoothstep(topBoundaryY + 0.010, topBoundaryY - 0.024, y);

    // Bottom cutoff: strictly terminates at the photographed floor line where the skirting meets the floorboards.
    // The entire flat face of the skirting board is fully covered by the shadow with no gap or highlight.
    float floorLineY = uWallFloorY;
    float bottomFade = smoothstep(floorLineY - 0.004, floorLineY + 0.001, y);

    // Outer penumbra roll-off
    float outer = smoothstep(currentReach, max(0.005, currentReach - currentSoftness), d);

    // Inner coverage: extends under the frame rail so there is never a visible light seam
    float inner = smoothstep(-0.06, 0.005, d);

    // Dense, warm core (umbra) close to the rail
    float core = smoothstep(currentReach * 0.50, 0.0, d) * 0.70;

    float shadowBody = outer * 0.68 + core;
    float alpha = clamp(shadowBody * inner * topFade * bottomFade * uOpacity, 0.0, uOpacity);

    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const floorVertexShader = `
  varying vec3 vWorldPosition;
  void main() {
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const floorFragmentShader = `
  varying vec3 vWorldPosition;
  uniform vec3 uFrameBottomLeft; // (leftEdge, floorY, frontZ)
  uniform float uWallZ;
  uniform float uReach;
  uniform float uSoftness;
  uniform float uOpacity;
  uniform vec3 uColor;

  void main() {
    float x = vWorldPosition.x;
    float z = vWorldPosition.z;

    float dx = uFrameBottomLeft.x - x;

    // Progress from bottom rail front (0.0) back to wall/skirting base (1.0)
    float zProgress = clamp((uFrameBottomLeft.z - z) / max(0.01, uFrameBottomLeft.z - uWallZ), 0.0, 1.0);

    // Triangular shadow on the floor:
    // At the bottom of the skirting board (z = uWallZ, progress = 1.0), it meets the wall shadow with width uReach.
    // At the frame bottom (z = uFrameBottomLeft.z, progress = 0.0), it cleanly meets the bottom-left corner of the frame.
    float currentReach = mix(0.015, uReach, pow(zProgress, 0.88));
    float currentSoftness = mix(0.015, uSoftness, zProgress);

    float xFade = smoothstep(currentReach, max(0.005, currentReach - currentSoftness), dx);
    float innerX = smoothstep(-0.04, 0.005, dx);

    // Strictly zero in front of the bottom rail: never extends in front of bottom of frame!
    float frontFade = smoothstep(uFrameBottomLeft.z + 0.005, uFrameBottomLeft.z - 0.015, z);
    float rearFade = smoothstep(uWallZ - 0.025, uWallZ - 0.005, z);

    float core = smoothstep(currentReach * 0.42, 0.0, dx) * 0.55;

    float alpha = clamp((xFade * 0.68 + core) * innerX * frontFade * rearFade * uOpacity, 0.0, uOpacity);

    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const contactVertexShader = `
  varying vec3 vWorldPosition;
  void main() {
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const contactFragmentShader = `
  varying vec3 vWorldPosition;
  uniform float uBottomZ;
  uniform float uFrontZ;
  uniform float uLeftX;
  uniform float uRightX;
  uniform float uOpacity;
  uniform vec3 uColor;

  void main() {
    float x = vWorldPosition.x;
    float z = vWorldPosition.z;

    // Fade softly at left and right extremes
    float xFade = smoothstep(uLeftX - 0.018, uLeftX + 0.012, x) * smoothstep(uRightX + 0.018, uRightX - 0.012, x);

    // Occlusion underneath the frame rail (z <= uFrontZ)
    // and soft forward roll-off in front of the front edge (z > uFrontZ)
    float forwardDist = z - uFrontZ;

    // Roll-off in front of the frame rail (soft penumbra on the floorboards)
    float frontFade = smoothstep(0.024, -0.002, forwardDist);

    // Behind bottom rail rear (fades smoothly into the rear cavity)
    float rearFade = smoothstep(uBottomZ - 0.020, uBottomZ + 0.006, z);

    // Crisp dark contact seam right along the front rail edge
    float seam = smoothstep(0.007, 0.000, forwardDist);
    float crevice = mix(0.45 * frontFade, 1.0, seam);

    float alpha = clamp(crevice * xFade * rearFade * frontFade * uOpacity, 0.0, uOpacity);
    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export default function LeaningFrameShadow({
  matrix,
  width,
  height,
  wallZ,
  floorY,
  strength,
  depthMm = 35,
}: {
  matrix: THREE.Matrix4;
  width: number;
  height: number;
  wallZ: number;
  floorY: number;
  strength: number;
  depthMm?: number;
}) {
  const centre = new THREE.Vector3().setFromMatrixPosition(matrix);
  const scale = new THREE.Vector3().setFromMatrixColumn(matrix, 0).length();
  const axisY = new THREE.Vector3().setFromMatrixColumn(matrix, 1);
  const worldWidth = width * scale;
  const projectedHeight = Math.abs(axisY.y) * height;
  const standOff = Math.abs(axisY.z) * height;
  const bottomZ = centre.z + standOff / 2;
  const topY = centre.y + projectedHeight / 2;
  const leftEdge = centre.x - worldWidth / 2;
  const rightEdge = centre.x + worldWidth / 2;

  // Actual physical depth of moulding profile in visualizer world units (1mm = 0.001m)
  const actualProfileDepth = depthMm * 0.001 * scale;
  const tiltRad = Math.asin(THREE.MathUtils.clamp(standOff / Math.max(0.001, height * scale), 0, 0.42));
  const frontZ = bottomZ + actualProfileDepth * Math.cos(tiltRad);

  // Optical standoff for shadow spread on the wall
  const opticalStandoff = standOff + actualProfileDepth * 0.5;
  const topReach = Math.max(0.08, actualProfileDepth * 1.2 + 0.05);
  const floorReach = Math.max(0.35, opticalStandoff * 1.35 + 0.08);

  const tightSoftness = Math.max(0.032, topReach * 0.38);
  const broadSoftness = floorReach * 0.52;
  const shadowOpacity = Math.min(0.88, 0.78 * strength);
  const shadowColor = useMemo(() => new THREE.Color('#19110c'), []);

  // On the 3D wall plane (z = 0), because the camera is elevated and angled downwards towards the
  // backdrop plane at z = -0.42, the photographed floor line at the base of the skirting board
  // appears at wallFloorY (screen space row 226).
  const wallFloorY = floorY - 0.106;

  // Wall shadow geometry dimensions: comfortably encompasses down to floorLineY
  const wallWidth = floorReach + 0.22;
  const wallHeight = (topY - wallFloorY) + 0.14;
  const wallCenterY = (topY + wallFloorY) / 2 + 0.01;

  // Floor triangular wedge connecting wall skirting (wallZ, wallFloorY) to front bottom-left corner of frame (frontZ, floorY)
  const floorDeltaY = floorY - wallFloorY;
  const floorDeltaZ = frontZ - wallZ;
  const floorDepth = Math.sqrt(floorDeltaY * floorDeltaY + floorDeltaZ * floorDeltaZ);
  const floorTilt = Math.atan2(floorDeltaY, floorDeltaZ);
  const floorWidth = floorReach + 0.12;
  const floorCenterY = (wallFloorY + floorY) / 2;
  const floorCenterZ = (wallZ + frontZ) / 2;

  // Contact shadow mesh spanning from under the bottom rail to just in front of it
  const contactMeshDepth = (frontZ - bottomZ) + 0.06;
  const contactMeshCenterZ = (bottomZ + frontZ) / 2 + 0.002;
  const contactMeshWidth = worldWidth + 0.05;

  const wallUniforms = useMemo(() => ({
    uFrameTopLeft: { value: new THREE.Vector2(leftEdge, topY) },
    uFloorY: { value: floorY },
    uWallFloorY: { value: wallFloorY },
    uTopReach: { value: topReach },
    uFloorReach: { value: floorReach },
    uTightSoftness: { value: tightSoftness },
    uBroadSoftness: { value: broadSoftness },
    uOpacity: { value: shadowOpacity },
    uColor: { value: shadowColor },
  }), [leftEdge, topY, floorY, wallFloorY, topReach, floorReach, tightSoftness, broadSoftness, shadowOpacity, shadowColor]);

  const floorUniforms = useMemo(() => ({
    uFrameBottomLeft: { value: new THREE.Vector3(leftEdge, floorY, frontZ) },
    uWallZ: { value: wallZ },
    uReach: { value: floorReach },
    uSoftness: { value: broadSoftness },
    uOpacity: { value: shadowOpacity },
    uColor: { value: new THREE.Color('#18110c') },
  }), [leftEdge, floorY, frontZ, wallZ, floorReach, broadSoftness, shadowOpacity]);

  const contactUniforms = useMemo(() => ({
    uBottomZ: { value: bottomZ },
    uFrontZ: { value: frontZ },
    uLeftX: { value: leftEdge },
    uRightX: { value: rightEdge },
    uOpacity: { value: Math.min(0.95, 0.88 * strength) },
    uColor: { value: new THREE.Color('#110a06') },
  }), [bottomZ, frontZ, leftEdge, rightEdge, strength]);

  return (
    <group name="realistic-leaning-shadows">
      {/* Wall Shadow with Continuous Optical Penumbra & Natural Diagonal Shoulder */}
      <mesh
        position={[leftEdge - wallWidth / 2 + 0.06, wallCenterY, wallZ + 0.0015]}
        renderOrder={-2}
      >
        <planeGeometry args={[wallWidth, wallHeight]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          uniforms={wallUniforms}
          vertexShader={wallVertexShader}
          fragmentShader={wallFragmentShader}
        />
      </mesh>

      {/* Floor Wedge connecting wall skirting to bottom rail (strictly behind bottom rail) */}
      <mesh
        position={[leftEdge - floorWidth / 2 + 0.03, floorCenterY + 0.0012, floorCenterZ]}
        rotation={[-Math.PI / 2 - floorTilt, 0, 0]}
        renderOrder={-2}
      >
        <planeGeometry args={[floorWidth, floorDepth]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          uniforms={floorUniforms}
          vertexShader={floorVertexShader}
          fragmentShader={floorFragmentShader}
        />
      </mesh>

      {/* Ground Contact Crevice (Ambient Occlusion pinning bottom rail directly to floorboards) */}
      <mesh
        position={[centre.x, floorY + 0.0014, contactMeshCenterZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={-1}
      >
        <planeGeometry args={[contactMeshWidth, contactMeshDepth]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          depthTest={true}
          uniforms={contactUniforms}
          vertexShader={contactVertexShader}
          fragmentShader={contactFragmentShader}
        />
      </mesh>
    </group>
  );
}
