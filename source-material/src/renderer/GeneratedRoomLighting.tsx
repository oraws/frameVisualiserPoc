import { Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { generatedScenes } from './roomTemplates';
import { softenWindowShadow, windowShadowRadius } from './softWindowShadow';

/** Shared with the offline generator. The browser approximates Cycles' area
 * shadows with a directional shadow map; it never paints a screen-space gobo.
 * The local EXR provides actual room reflections and diffuse fill.
 */
export default function GeneratedRoomLighting({ sceneId, strength, fill, shadow, depthMm }: {sceneId:string;strength:number;fill:number;shadow:number;depthMm:number}) {
  const scene = generatedScenes[sceneId];
  // Cycles watts and Three's area-light luminance are different units. This
  // preview calibration is shared by both prepared rooms; area normalisation
  // keeps a larger window from silently adding energy at the same wattage.
  // Three's rect-area intensity is not expressed in the same units as the
  // Cycles wattage used to bake the room. Calibrate the interactive foreground
  // against the neutral Frame detail view instead of applying the raw quotient,
  // which lifts dark matte mouldings into mid-grey.
  const windowLuminance = scene.keyLight.powerWatts / (3 * Math.PI * scene.keyLight.width * scene.keyLight.height) * .01;
  const invalidate = useThree(state => state.invalidate);
  const area = useRef<THREE.RectAreaLight>(null);
  const lightDistance = new THREE.Vector3(...scene.keyLight.position).distanceTo(new THREE.Vector3(...scene.keyLight.target));
  const shadowRadius = windowShadowRadius(depthMm, lightDistance, scene.keyLight.width) * .6;
  const target = useMemo(() => {
    RectAreaLightUniformsLib.init();
    const object = new THREE.Object3D();
    object.position.fromArray(scene.keyLight.target);
    return object;
  }, [sceneId]);
  useEffect(() => { area.current?.lookAt(target.position); invalidate(); }, [target, invalidate]);
  return <>
    <primitive object={target} />
    <ambientLight intensity={scene.fill * fill} color="#e6efff" />
    <Environment files={scene.environment} environmentIntensity={fill} environmentRotation={[0, Math.PI / 2, 0]} />
    <rectAreaLight ref={area} position={scene.keyLight.position as [number,number,number]} color={scene.keyLight.color}
      intensity={windowLuminance * strength} width={scene.keyLight.width} height={scene.keyLight.height} />
    <directionalLight position={scene.keyLight.position as [number,number,number]} target={target}
      color={scene.keyLight.color} intensity={scene.keyLight.intensity * strength * .22} castShadow
      shadow-mapSize={[2048,2048]} shadow-camera-left={-3.5} shadow-camera-right={3.5}
      shadow-camera-top={3.5} shadow-camera-bottom={-3.5} shadow-camera-near={.1} shadow-camera-far={18}
      shadow-bias={-.00004} shadow-normalBias={.001} shadow-radius={shadowRadius} />
    <mesh position={[0, .65, scene.wallZ]} receiveShadow>
      <planeGeometry args={[11,8]} />
      <shadowMaterial key="gaussian-window-wall" transparent color="#685132" opacity={Math.min(.65, .32 * shadow)} depthWrite={false}
        onBeforeCompile={softenWindowShadow} customProgramCacheKey={() => 'gaussian-window-wall-v2'} />
    </mesh>
    {/* Depth-only proxies keep a lowered frame behind foreground furnishings.
        The visible furniture is already in the room photograph. */}
    {sceneId === "generated-gallery" && <>
    <mesh position={[.15, -1.98, .51]} renderOrder={-10}>
      <boxGeometry args={[3.95,.59,.83]} />
      <meshBasicMaterial colorWrite={false} />
    </mesh>
    <mesh position={[.15, -1.66, .53]} renderOrder={-10}>
      <boxGeometry args={[4.08,.065,.89]} />
      <meshBasicMaterial colorWrite={false} />
    </mesh>
    <mesh position={[-1.22,-1.62,.52]} renderOrder={-10}>
      <latheGeometry args={[[[0,.12],[.04,.17],[.22,.23],[.45,.2],[.6,.085],[.66,.08],[.67,.06]].map(([y,r])=>new THREE.Vector2(r,y)),64]} />
      <meshBasicMaterial colorWrite={false} side={THREE.DoubleSide} />
    </mesh>
    </>}
    {sceneId === "sofa-gallery" && <mesh position={[-.2,-1.73,.38]} renderOrder={-10}><boxGeometry args={[5.58,1.4,.47]} /><meshBasicMaterial colorWrite={false} /></mesh>}
  </>;
}
