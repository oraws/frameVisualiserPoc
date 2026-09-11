import {
  OrbitControls,
  Environment,
  ContactShadows,
  Text,
  PerspectiveCamera,
  useTexture,
} from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeElements } from "@react-three/fiber";
import * as THREE from "three";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Moulding } from "../mouldings/catalog";
import {
  centradoProfile,
  flat54x20Profile,
  mainlineCatalogueProfile,
  pol4100Profile,
  pol4508BlackProfile,
  pol4508SamBlackProfile,
  pol4508SamSilverProfile,
  pol4508SilverProfile,
  veronaProfile,
  veronaSamProfile,
  type ProfilePoint,
} from "../mouldings/profiles";
import { createProfileFrameGeometry } from "./profileGeometry";
import { fallbackRoom, roomPresets, generatedScenes, type RoomTemplate } from "./roomTemplates";
import mainlineMaterials from "../mouldings/mainlineMaterials.json";
import materialPilotsV3 from "../mouldings/materialPilotsV3.json";
import FrameWallContact from "./FrameWallContact";
import GeneratedRoomLighting from "./GeneratedRoomLighting";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { fittedRoomFov } from "./generatedRoomMath";

// Generated rooms use the full room reflection capture, as the offline PBR
// renderer does. Legacy studio/photo materials retain their authored damping.
const GeneratedMaterialContext = createContext(false);
type ColourFaithfulStandardProps = ThreeElements["meshStandardMaterial"] & {
  colourFidelity?: number;
};
type ColourFaithfulPhysicalProps = ThreeElements["meshPhysicalMaterial"] & {
  colourFidelity?: number;
};

function colourFidelityShader(fidelity: number) {
  const mixAmount = THREE.MathUtils.clamp(fidelity, 0, 1).toFixed(4);
  return (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `// Keep product colour anchored to its calibrated supplier base colour.\n` +
      `outgoingLight = mix(outgoingLight, diffuseColor.rgb, ${mixAmount});\n` +
      "#include <opaque_fragment>",
    );
  };
}

function RoomStandardMaterial({ colourFidelity = 0, ...props }: ColourFaithfulStandardProps) {
  const generated = useContext(GeneratedMaterialContext);
  const effectiveFidelity = generated ? colourFidelity : 0;
  const onBeforeCompile = useMemo(
    () => colourFidelityShader(effectiveFidelity),
    [effectiveFidelity],
  );
  return <meshStandardMaterial {...props}
    envMapIntensity={generated ? props.envMapIntensity ?? .55 : props.envMapIntensity}
    onBeforeCompile={onBeforeCompile}
    customProgramCacheKey={() => `supplier-colour-${effectiveFidelity.toFixed(4)}`}
  />;
}

function RoomPhysicalMaterial({ colourFidelity = 0, ...props }: ColourFaithfulPhysicalProps) {
  const generated = useContext(GeneratedMaterialContext);
  const effectiveFidelity = generated ? colourFidelity : 0;
  const onBeforeCompile = useMemo(
    () => colourFidelityShader(effectiveFidelity),
    [effectiveFidelity],
  );
  return <meshPhysicalMaterial {...props}
    envMapIntensity={generated ? props.envMapIntensity ?? .55 : props.envMapIntensity}
    onBeforeCompile={onBeforeCompile}
    customProgramCacheKey={() => `supplier-colour-${effectiveFidelity.toFixed(4)}`}
  />;
}

type ReviewedFinish = {
  gloss: "matte" | "satin" | "gloss";
  roughness: number;
  clearcoat: number;
  envMapIntensity: number;
  colourFidelity: number;
};

function useReviewedFinish(sku: string, variant: string): ReviewedFinish | null {
  const [variantName, revision] = variant.split("@");
  const isReview = variantName === "supplier-matched-v4-candidate" ||
    /^review-\d{14}-[a-f0-9]{8}$/.test(variantName);
  const [finish, setFinish] = useState<ReviewedFinish | null>(null);
  useEffect(() => {
    if (!isReview) { setFinish(null); return; }
    const controller = new AbortController();
    const cacheKey = revision ? `?review=${encodeURIComponent(revision)}` : "";
    fetch(`/assets/mouldings/${sku}/variants/${variantName}/quality-report.json${cacheKey}`, {
      cache: "no-store", signal: controller.signal,
    }).then(response => response.ok ? response.json() : Promise.reject())
      .then(report => {
        const description = `${report.agents?.analyst?.gloss || ""} ${report.agents?.analyst?.finishClass || ""}`.toLowerCase();
        const gloss: ReviewedFinish["gloss"] = /matte|matt/.test(description)
          ? "matte" : /gloss|polished|lacquer/.test(description) ? "gloss" : "satin";
        setFinish(gloss === "matte"
          ? { gloss, roughness: 1, clearcoat: 0, envMapIntensity: .12, colourFidelity: .88 }
          : gloss === "gloss"
            ? { gloss, roughness: .58, clearcoat: .22, envMapIntensity: .34, colourFidelity: .46 }
            : { gloss, roughness: .86, clearcoat: .035, envMapIntensity: .2, colourFidelity: .7 });
      }).catch(reason => { if (reason.name !== "AbortError") setFinish(null); });
    return () => controller.abort();
  }, [sku, variantName, revision, isReview]);
  return finish;
}

type ProfileVariant = "Current" | "SAM 2.1" | "Catalogue";
type ScaleReference = { lengthMm: number; pointsNormalised: number[][] };
type RoomLighting = {
  azimuth: number;
  elevation: number;
  keyStrength: number;
  ambientStrength: number;
  temperature: number;
  shadowOpacity: number;
  shadowSoftness: number;
  shadowGapMm: number;
  goboEnabled?: boolean;
  goboAngle?: number;
  goboScale?: number;
  goboOffsetX?: number;
  goboOffsetY?: number;
  goboStrength?: number;
  goboSoftness?: number;
  foregroundBrightness?: number;
  foregroundSaturation?: number;
  foregroundWarmth?: number;
};
type RoomCalibration = {
  manualCalibration?: {
    quadNormalised: number[][];
    frameCentreNormalised?: number[];
    scaleReference?: ScaleReference;
  };
  renderer?: {
    cameraFovDegrees?: number;
    wallYawDegrees?: number;
    wallPitchDegrees?: number;
    perspectiveMode?: string;
    lighting?: RoomLighting;
  };
};
type Props = {
  onExportReady?: (exporter: (() => Promise<ArrayBuffer>) | null) => void;
  moulding: Moulding;
  artWidth: number;
  artHeight: number;
  mount: number;
  mountColor: string;
  innerMount: number;
  innerMountColor: string;
  glass: string;
  lighting: string;
  lightStrength: number;
  ambientFill: number;
  exposure: number;
  wallColour: string;
  view: string;
  debug: boolean;
  artwork: string;
  artworkColourMode?: "Source colours" | "Room lighting";
  geometryMode: "Profile" | "Flat Legacy";
  materialMode: "Texture" | "Clay" | "Normal" | "Wireframe";
  displayMode: "Inspect" | "Wall";
  wallPreset: string;
  wallPositionX: number;
  wallPositionY: number;
  wallScale: number;
  wallShadow: number;
  roomMatchStrength: number;
  materialVariant: string;
  materialRevision: number;
  reviewProfile?: Array<[number, number]>;
  profileVariant: ProfileVariant;
  roomCalibration?: RoomCalibration | null;
  roomTemplate?: RoomTemplate;
  roomImageFit?: "contain" | "cover";
  overlayOnly?: boolean;
  onWallProjection?: (corners: number[][]) => void;
};

function CameraPoseReporter() {
  const { camera, gl } = useThree();
  useFrame(() => {
    gl.domElement.dataset.cameraPose = [
      ...camera.position.toArray(),
      ...camera.quaternion.toArray(),
    ].map((value) => value.toFixed(6)).join(",");
  });
  return null;
}
const mm = 0.0025;
function temperatureColour(kelvin: number) {
  const t = Math.max(10, Math.min(400, kelvin / 100));
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return new THREE.Color(
    Math.max(0, Math.min(255, r)) / 255,
    Math.max(0, Math.min(255, g)) / 255,
    Math.max(0, Math.min(255, b)) / 255,
  );
}
function roomPlaneMetrics(
  room: RoomTemplate,
  size: { width: number; height: number },
) {
  const planeZ = -0.42,
    cameraZ = room.camera.position[2],
    viewHeight =
      2 *
      (cameraZ - planeZ) *
      Math.tan(THREE.MathUtils.degToRad(room.camera.fov / 2));
  if (!room.imageAspect)
    return { width: 11.7, height: 6.58, centerX: 0, centerY: 0.1, planeZ };
  const viewWidth = viewHeight * (size.width / Math.max(1, size.height));
  let width: number, height: number;
  if (viewWidth / viewHeight < room.imageAspect) {
    height = viewHeight;
    width = height * room.imageAspect;
  } else {
    width = viewWidth;
    height = width / room.imageAspect;
  }
  const centerX = room.imageAnchorX === "left" ? -viewWidth / 2 + width / 2 : 0;
  return { width, height, centerX, centerY: 0.1, planeZ };
}
function quadHomography(quad: number[][]) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    dy1 = y1 - y2,
    dy2 = y3 - y2,
    sx = x0 - x1 + x2 - x3,
    sy = y0 - y1 + y2 - y3,
    denominator = dx1 * dy2 - dx2 * dy1;
  const g =
      Math.abs(denominator) > 1e-8 ? (sx * dy2 - dx2 * sy) / denominator : 0,
    h = Math.abs(denominator) > 1e-8 ? (dx1 * sy - sx * dy1) / denominator : 0;
  return [
    x1 - x0 + g * x1,
    x3 - x0 + h * x3,
    x0,
    y1 - y0 + g * y1,
    y3 - y0 + h * y3,
    y0,
    g,
    h,
    1,
  ];
}
function transformPoint(matrix: number[], point: number[]) {
  const denominator = matrix[6] * point[0] + matrix[7] * point[1] + matrix[8];
  return [
    (matrix[0] * point[0] + matrix[1] * point[1] + matrix[2]) / denominator,
    (matrix[3] * point[0] + matrix[4] * point[1] + matrix[5]) / denominator,
  ];
}
function inverse3(m: number[]) {
  const [a, b, c, d, e, f, g, h, i] = m,
    A = e * i - f * h,
    B = c * h - b * i,
    C = b * f - c * e,
    D = f * g - d * i,
    E = a * i - c * g,
    F = c * d - a * f,
    G = d * h - e * g,
    H = b * g - a * h,
    I = a * e - b * d,
    det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-10) return null;
  return [
    A / det,
    B / det,
    C / det,
    D / det,
    E / det,
    F / det,
    G / det,
    H / det,
    I / det,
  ];
}
function calibratedFramePose(
  quad: number[][],
  size: { width: number; height: number },
  room: RoomTemplate,
  calibration?: RoomCalibration | null,
  imageFit: "contain" | "cover" = "contain",
) {
  const imageAspect = room.imageAspect || size.width / Math.max(1, size.height),
    stageAspect = size.width / Math.max(1, size.height);
  let displayedWidth: number,
    displayedHeight: number,
    offsetX = 0,
    offsetY = 0;
  if (
    (imageFit === "cover" && stageAspect < imageAspect) ||
    (imageFit === "contain" && stageAspect >= imageAspect)
  ) {
    displayedHeight = size.height;
    displayedWidth = displayedHeight * imageAspect;
    offsetX = imageFit === "cover" && room.imageAnchorX === "left"
      ? 0
      : (size.width - displayedWidth) / 2;
  } else {
    displayedWidth = size.width;
    displayedHeight = displayedWidth / imageAspect;
    offsetY = (size.height - displayedHeight) / 2;
  }
  const toPixels = (point: number[]) => [
      offsetX + point[0] * displayedWidth,
      offsetY + point[1] * displayedHeight,
    ],
    pixelQuad = quad.map(toPixels),
    reference = calibration?.manualCalibration?.scaleReference || {
      lengthMm: 2400,
      pointsNormalised: [
        [0.12, 0.18],
        [0.12, 0.72],
      ],
    },
    focal =
      size.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(room.camera.fov / 2))),
    cx = size.width / 2,
    cy = size.height / 2;
  // Decompose the exact admin homography. Keeping its two independent plane axes
  // (rather than replacing them with a guessed yaw) makes the rendered outline
  // project back onto the quadrilateral the administrator approved.
  const homography = quadHomography(pixelQuad),
    inverse = inverse3(homography);
  if (!inverse) return { matrix: new THREE.Matrix4() };
  const cameraVector = (column: number) =>
    new THREE.Vector3(
      (homography[column] - cx * homography[column + 6]) / focal,
      (homography[column + 3] - cy * homography[column + 6]) / focal,
      homography[column + 6],
    );
  const axisU = cameraVector(0),
    axisV = cameraVector(1),
    origin = cameraVector(2),
    axisNorm = (axisU.length() + axisV.length()) / 2;
  const referenceLocal = reference.pointsNormalised.map((point) =>
      transformPoint(inverse, toPixels(point)),
    ),
    referenceLocalLength = Math.max(
      1e-6,
      Math.hypot(
        referenceLocal[1][0] - referenceLocal[0][0],
        referenceLocal[1][1] - referenceLocal[0][1],
      ),
    ),
    worldPerSource = (reference.lengthMm * mm) / referenceLocalLength,
    sceneScale = worldPerSource / Math.max(axisNorm, 1e-6),
    frameCentre = calibration?.manualCalibration?.frameCentreNormalised || [
      0.5, 0.5,
    ];
  const centreCv = origin
    .clone()
    .addScaledVector(axisU, frameCentre[0])
    .addScaledVector(axisV, frameCentre[1])
    .multiplyScalar(sceneScale);
  const cvToThree = (vector: THREE.Vector3) =>
      new THREE.Vector3(vector.x, -vector.y, -vector.z),
    // The homography columns contain both wall orientation and the arbitrary
    // width/height of the admin grid. Carrying those unequal lengths into the
    // object matrix stretches the framed artwork differently in each room.
    // Keep only their directions and rebuild an orthonormal wall basis so one
    // metre remains one metre on both axes; camera perspective supplies the
    // apparent foreshortening.
    basisX = cvToThree(axisU).normalize(),
    basisYHint = cvToThree(axisV).multiplyScalar(-1).normalize(),
    basisZ = new THREE.Vector3().crossVectors(basisX, basisYHint).normalize(),
    basisY = new THREE.Vector3().crossVectors(basisZ, basisX).normalize();
  const position = new THREE.Vector3(
      room.camera.position[0] + centreCv.x,
      room.camera.position[1] - centreCv.y,
      room.camera.position[2] - centreCv.z,
    );
  // A room calibration contains one trustworthy metric reference (normally
  // floor-to-ceiling), so it fixes the vertical scale but cannot independently
  // establish the physical width represented by the administrator's arbitrary
  // quadrilateral. Measure both recovered wall axes at the frame centre and
  // compensate the uncalibrated horizontal axis. This keeps a 700 x 500 mm
  // artwork at 7:5 in every room while retaining the approved wall directions.
  const projectionCamera = new THREE.PerspectiveCamera(
      room.camera.fov,
      size.width / Math.max(1, size.height),
      0.01,
      100,
    ),
    cameraTarget = new THREE.Vector3(0, 0.1, 0);
  projectionCamera.position.fromArray(room.camera.position);
  projectionCamera.lookAt(cameraTarget);
  projectionCamera.updateMatrixWorld();
  projectionCamera.updateProjectionMatrix();
  const projectedCentre = position.clone().project(projectionCamera),
    projectedX = position.clone().add(basisX).project(projectionCamera),
    projectedY = position.clone().add(basisY).project(projectionCamera),
    pixelsPerX = Math.hypot(
      (projectedX.x - projectedCentre.x) * size.width * 0.5,
      (projectedX.y - projectedCentre.y) * size.height * 0.5,
    ),
    pixelsPerY = Math.hypot(
      (projectedY.x - projectedCentre.x) * size.width * 0.5,
      (projectedY.y - projectedCentre.y) * size.height * 0.5,
    ),
    horizontalMetricCorrection = THREE.MathUtils.clamp(
      pixelsPerY / Math.max(1e-6, pixelsPerX),
      0.4,
      2.5,
    ),
    matrix = new THREE.Matrix4()
      .makeBasis(
        basisX.multiplyScalar(horizontalMetricCorrection),
        basisY,
        basisZ,
      )
      .setPosition(position);
  return { matrix };
}
function shape(points: number[][]) {
  return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
}
function OrnateMaterial() {
  const map = useTexture("/assets/mouldings/POL-4875/profile-strip.jpg");
  useMemo(() => {
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(3.5, 1.4);
    map.anisotropy = 8;
    map.needsUpdate = true;
  }, [map]);
  return (
    <RoomStandardMaterial
      map={map}
      color="#8d8990"
      roughness={0.53}
      metalness={0.26}
      envMapIntensity={0.16}
      colourFidelity={0.42}
    />
  );
}
function Rail({
  points,
  moulding,
  depth,
}: {
  points: number[][];
  moulding: Moulding;
  depth?: number;
}) {
  const d = depth ?? moulding.depthMm * mm;
  const geometry = useMemo(
    () =>
      new THREE.ExtrudeGeometry(shape(points), {
        depth: d,
        bevelEnabled: true,
        bevelThickness: Math.min(0.009, d * 0.16),
        bevelSize: 0.007,
        bevelSegments: 3,
      }),
    [points, d],
  );
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      {moulding.profileType === "ornate-scoop" ? (
        <OrnateMaterial />
      ) : (
        <RoomPhysicalMaterial
          color={moulding.baseColor}
          roughness={moulding.roughness}
          metalness={moulding.sku === "4925BG" ? 0.08 : 0.02}
          clearcoat={0.08}
          envMapIntensity={0.18}
          colourFidelity={0.68}
        />
      )}
    </mesh>
  );
}
function railSet(ow: number, oh: number, iw: number, ih: number): number[][][] {
  return [
    [
      [-ow / 2, oh / 2],
      [ow / 2, oh / 2],
      [iw / 2, ih / 2],
      [-iw / 2, ih / 2],
    ],
    [
      [-ow / 2, -oh / 2],
      [-iw / 2, -ih / 2],
      [iw / 2, -ih / 2],
      [ow / 2, -oh / 2],
    ],
    [
      [-ow / 2, -oh / 2],
      [-iw / 2, -ih / 2],
      [-iw / 2, ih / 2],
      [-ow / 2, oh / 2],
    ],
    [
      [ow / 2, -oh / 2],
      [iw / 2, -ih / 2],
      [iw / 2, ih / 2],
      [ow / 2, oh / 2],
    ],
  ];
}
function ProfileFrame({
  openingWidthMm,
  openingHeightMm,
  materialMode,
  moulding,
  profile,
  materialVariant,
}: {
  openingWidthMm: number;
  openingHeightMm: number;
  materialMode: Props["materialMode"];
  moulding: Moulding;
  profile: ProfilePoint[];
  materialVariant: string;
}) {
  const renderedProfile = useMemo(() => {
    const curvedProfile = ["ornate-scoop", "scoop", "reverse", "cushion"].includes(
      moulding.profileType,
    );
    if (!curvedProfile) return profile;
    let smoothed = profile.map(([x, z]) => [x, z] as ProfilePoint);
    const passes = moulding.profileType === "ornate-scoop" ? 3 : 2;
    for (let pass = 0; pass < passes; pass += 1) {
      smoothed = smoothed.map((point, index, points) => {
        if (index === 0 || index === points.length - 1) return point;
        return [
          point[0],
          points[index - 1][1] * 0.2 +
            point[1] * 0.6 +
            points[index + 1][1] * 0.2,
        ];
      });
    }
    return smoothed;
  }, [moulding.sku, profile]);
  const geometry = useMemo(
    () =>
      createProfileFrameGeometry(
        openingWidthMm,
        openingHeightMm,
        renderedProfile,
      ),
    [openingWidthMm, openingHeightMm, renderedProfile],
  );
  if (materialMode === "Normal")
    return (
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshNormalMaterial />
      </mesh>
    );
  if (materialMode === "Wireframe")
    return (
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#d8b976" wireframe />
      </mesh>
    );
  if (materialMode === "Clay")
    return (
      <mesh geometry={geometry} castShadow receiveShadow>
        <RoomStandardMaterial color="#8b8983" roughness={0.68} />
      </mesh>
    );
  const requestedVariant = materialVariant.split("@")[0];
  const hasSupplierMaps = moulding.sku in mainlineMaterials ||
    requestedVariant === "supplier-matched-v4-candidate" ||
    /^review-\d{14}-[a-f0-9]{8}$/.test(requestedVariant);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      {hasSupplierMaps ? (
        <SupplierVariantMaterial
          moulding={moulding}
          variant={materialVariant}
        />
      ) : (
        <RoomStandardMaterial
          color={moulding.baseColor}
          roughness={moulding.roughness}
          metalness={
            /Gold|Silver|Bronze|Gunmetal/i.test(moulding.finish) ? 0.12 : 0
          }
          envMapIntensity={0.18}
          colourFidelity={/Gold|Silver|Bronze|Gunmetal/i.test(moulding.finish) ? 0.4 : 0.72}
          flatShading
        />
      )}
    </mesh>
  );
}
function SupplierVariantMaterial({
  moulding,
  variant,
}: {
  moulding: Moulding;
  variant: string;
}) {
  const [requestedVariant, revision] = variant.split("@");
  const reviewedFinish = useReviewedFinish(moulding.sku, variant);
  const pilot = materialPilotsV3[
    moulding.sku as keyof typeof materialPilotsV3
  ];
  const selected =
      /^review-\d{14}-[a-f0-9]{8}$/.test(requestedVariant) || requestedVariant === "supplier-matched-v4-candidate"
        ? requestedVariant
      : moulding.sku === "POL-4100" && requestedVariant === "baseline-v1"
        ? "baseline-v1"
        : requestedVariant === "supplier-derived-v3" && pilot
          ? "supplier-derived-v3"
        : requestedVariant === "multiframe-experiment-v1" &&
            ["POL-4508", "POL-4418", "POL-4211"].includes(moulding.sku)
          ? "multiframe-experiment-v1"
          : "supplier-derived-v2",
    root = `/assets/mouldings/${moulding.sku}/variants/${selected}`,
    cacheKey = revision ? `?review=${encodeURIComponent(revision)}` : "";
  const [map, roughnessMap, bumpMap] = useTexture([
    `${root}/basecolor.jpg${cacheKey}`,
    `${root}/roughness.jpg${cacheKey}`,
    `${root}/bump.jpg${cacheKey}`,
  ]);
  useMemo(() => {
    for (const texture of [map, roughnessMap, bumpMap]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 16;
      texture.needsUpdate = true;
    }
    map.colorSpace = THREE.SRGBColorSpace;
    const repeatX =
      selected === "supplier-matched-v4-candidate" || selected.startsWith("review-")
        ? .25
        : selected === "supplier-derived-v3" && pilot
        ? 130 / pilot.physicalLengthMm
        : 1;
    for (const texture of [map, roughnessMap, bumpMap]) {
      texture.repeat.set(repeatX, 1);
    }
  }, [map, roughnessMap, bumpMap, pilot, selected]);
  const approvedSettings: Record<
    string,
    {
      bump: number;
      roughness: number;
      metalness: number;
      env: number;
      color: string;
    }
  > = {
    "POL-4100": {
      bump: 0.0065,
      roughness: 0.9,
      metalness: 0,
      env: 0.15,
      color: "#d2d4d1",
    },
    "POL-4508": {
      bump: 0.00018,
      roughness: 0.82,
      metalness: 0,
      env: 0.16,
      color: "#393b39",
    },
    "POL-4418": {
      bump: 0.00035,
      roughness: 0.66,
      metalness: 0.08,
      env: 0.2,
      color: "#c7ac90",
    },
    "POL-4211": {
      bump: 0.00045,
      roughness: 0.78,
      metalness: 0,
      env: 0.16,
      color: "#e1d7c8",
    },
    "POL-2104": {
      bump: 0.00042,
      roughness: 0.68,
      metalness: 0.08,
      env: 0.18,
      color: "#aaa39a",
    },
  };
  const finish = `${moulding.name} ${moulding.finish}`;
  const metallic = /gold|silver|bronze|gunmetal|metallic|lustre/i.test(finish);
  const dark = /black|midnight|charcoal/i.test(finish);
  const pale = /white|ivory|cream/i.test(finish);
  const wood = /oak|walnut|woodgrain|wood grain|pine|natural/i.test(finish);
  const generated = {
    bump: wood ? 0.00055 : moulding.ornament > 0.55 ? 0.00048 : 0.00034,
    roughness: Math.max(0.52, Math.min(0.9, moulding.roughness + 0.18)),
    metalness: metallic ? 0.1 : 0,
    env: metallic ? 0.2 : 0.16,
    color: /antique gold/i.test(finish)
      ? "#aaa39a"
      : /gold/i.test(finish)
        ? "#d8cfbc"
        : /bronze/i.test(finish)
          ? "#c7b6a7"
          : /silver|gunmetal/i.test(finish)
            ? "#d5d5d2"
        : dark
          ? "#d0d2cf"
          : pale
            ? "#eeeae2"
            : wood
              ? "#d5cec4"
              : "#d8d4cf",
  };
  const s = approvedSettings[moulding.sku] || generated;
  if (reviewedFinish) return (
    <RoomPhysicalMaterial
      map={map}
      roughnessMap={roughnessMap}
      bumpMap={bumpMap}
      bumpScale={s.bump}
      color={s.color}
      roughness={reviewedFinish.roughness}
      metalness={s.metalness}
      clearcoat={reviewedFinish.clearcoat}
      envMapIntensity={reviewedFinish.envMapIntensity}
      colourFidelity={reviewedFinish.colourFidelity}
    />
  );
  return (
    <RoomStandardMaterial
      map={map}
      roughnessMap={roughnessMap}
      bumpMap={bumpMap}
      bumpScale={s.bump}
      color={s.color}
      roughness={s.roughness}
      metalness={s.metalness}
      envMapIntensity={s.env}
      colourFidelity={metallic ? 0.42 : dark ? 0.82 : 0.7}
      flatShading={false}
    />
  );
}
function splitProfile(
  profile: ProfilePoint[],
  cutoff: number,
): [ProfilePoint[], ProfilePoint[]] {
  const crossing = profile.findIndex(([u]) => u >= cutoff);
  if (crossing <= 0) return [profile, profile];
  const before = profile[crossing - 1],
    after = profile[crossing];
  const ratio = (cutoff - before[0]) / Math.max(after[0] - before[0], 1e-6);
  const join: [number, number] = [
    cutoff,
    before[1] + (after[1] - before[1]) * ratio,
  ];
  return [
    [...profile.slice(0, crossing), join],
    [join, ...profile.slice(crossing)],
  ];
}
function CentradoMaterial({
  moulding,
  part,
  mode,
  materialVariant,
}: {
  moulding: Moulding;
  part: "base" | "accent";
  mode: Props["materialMode"];
  materialVariant: string;
}) {
  const pilot = materialPilotsV3[
    moulding.sku as keyof typeof materialPilotsV3
  ];
  const [requestedVariant, revision] = materialVariant.split("@");
  const reviewedFinish = useReviewedFinish(moulding.sku, materialVariant);
  const useReview = part === "base" && (requestedVariant === "supplier-matched-v4-candidate" ||
    /^review-\d{14}-[a-f0-9]{8}$/.test(requestedVariant));
  const usePilot =
    part === "base" && requestedVariant === "supplier-derived-v3" && !!pilot;
  const pilotRoot = `/assets/mouldings/${moulding.sku}/variants/supplier-derived-v3`;
  const reviewRoot = `/assets/mouldings/${moulding.sku}/variants/${requestedVariant}`;
  const cacheKey = revision ? `?review=${encodeURIComponent(revision)}` : "";
  const [map, roughnessMap, bumpMap] = useTexture([
    useReview
      ? `${reviewRoot}/basecolor.jpg${cacheKey}`
      : usePilot
      ? `${pilotRoot}/basecolor.jpg`
      : `/assets/mouldings/${moulding.sku}/${part}-texture.jpg`,
    useReview
      ? `${reviewRoot}/roughness.jpg${cacheKey}`
      : usePilot
      ? `${pilotRoot}/roughness.jpg`
      : `/assets/mouldings/${moulding.sku}/${part}-bump.jpg`,
    useReview
      ? `${reviewRoot}/bump.jpg${cacheKey}`
      : usePilot
      ? `${pilotRoot}/bump.jpg`
      : `/assets/mouldings/${moulding.sku}/${part}-bump.jpg`,
  ]);
  useMemo(() => {
    for (const texture of [map, roughnessMap, bumpMap]) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 16;
      texture.needsUpdate = true;
    }
    map.colorSpace = THREE.SRGBColorSpace;
    const repeatX = useReview ? .25 : usePilot && pilot ? 130 / pilot.physicalLengthMm : 1.8;
    for (const texture of [map, roughnessMap, bumpMap]) {
      texture.repeat.set(repeatX, 1);
    }
  }, [map, roughnessMap, bumpMap, pilot, usePilot, useReview]);
  if (mode === "Normal") return <meshNormalMaterial />;
  if (mode === "Wireframe")
    return (
      <meshBasicMaterial
        color={
          part === "accent" ? moulding.accentColor || "#d4a63d" : "#d8b976"
        }
        wireframe
      />
    );
  if (mode === "Clay")
    return <RoomStandardMaterial color="#8b8983" roughness={0.68} />;
  const metallic = /gold|silver|bronze|lustre/i.test(
    part === "accent"
      ? moulding.accentColor || moulding.finish
      : moulding.finish,
  );
  return (
    <RoomPhysicalMaterial
      map={map}
      roughnessMap={usePilot || useReview ? roughnessMap : undefined}
      bumpMap={bumpMap}
      bumpScale={part === "accent" ? 0.0008 : 0.00115}
      color="#ffffff"
      metalness={metallic ? 0.42 : 0.01}
      roughness={part === "accent" ? 0.42 : reviewedFinish?.roughness ?? moulding.roughness}
      clearcoat={part === "accent" ? 0.12 : reviewedFinish?.clearcoat ?? 0.04}
      envMapIntensity={part === "accent" ? 0.4 : reviewedFinish?.envMapIntensity ?? 0.2}
      colourFidelity={part === "accent" || metallic ? 0.4 : reviewedFinish?.colourFidelity ?? 0.7}
    />
  );
}
function CentradoFrame({
  openingWidthMm,
  openingHeightMm,
  materialMode,
  moulding,
  profile,
  materialVariant,
}: {
  openingWidthMm: number;
  openingHeightMm: number;
  materialMode: Props["materialMode"];
  moulding: Moulding;
  profile: ProfilePoint[];
  materialVariant: string;
}) {
  const accentWidth = moulding.accentWidthMm || 0;
  const [accentProfile, remainder] = useMemo(
    () => splitProfile(profile, accentWidth),
    [profile, accentWidth],
  );
  const baseProfile = accentWidth > 0 ? remainder : profile;
  const baseGeometry = useMemo(
    () =>
      createProfileFrameGeometry(openingWidthMm, openingHeightMm, baseProfile),
    [openingWidthMm, openingHeightMm, baseProfile],
  );
  const accentGeometry = useMemo(
    () =>
      createProfileFrameGeometry(
        openingWidthMm,
        openingHeightMm,
        accentProfile,
      ),
    [openingWidthMm, openingHeightMm, accentProfile],
  );
  return (
    <group>
      <mesh geometry={baseGeometry} castShadow receiveShadow>
        <CentradoMaterial
          moulding={moulding}
          part="base"
          mode={materialMode}
          materialVariant={materialVariant}
        />
      </mesh>
      {accentWidth > 0 && (
        <mesh geometry={accentGeometry} castShadow receiveShadow>
          <CentradoMaterial
            moulding={moulding}
            part="accent"
            mode={materialMode}
            materialVariant={materialVariant}
          />
        </mesh>
      )}
    </group>
  );
}
function ParamountSilverMaterial({
  mode,
  moulding,
}: {
  mode: Props["materialMode"];
  moulding: Moulding;
}) {
  if (mode === "Normal") return <meshNormalMaterial />;
  if (mode === "Wireframe")
    return <meshBasicMaterial color="#d8b976" wireframe />;
  if (mode === "Clay")
    return <RoomStandardMaterial color="#8b8983" roughness={0.68} />;
  return (
    <RoomPhysicalMaterial
      color={moulding.accentColor || "#c5c2b9"}
      metalness={0.82}
      roughness={0.23}
      clearcoat={0.12}
      envMapIntensity={0.56}
      colourFidelity={0.36}
    />
  );
}
function ParamountFrame({
  openingWidthMm,
  openingHeightMm,
  materialMode,
  moulding,
  materialVariant,
}: {
  openingWidthMm: number;
  openingHeightMm: number;
  materialMode: Props["materialMode"];
  moulding: Moulding;
  materialVariant: string;
}) {
  const accentWidth = moulding.accentWidthMm || 9.5;
  const silverGeometry = useMemo(
    () =>
      createProfileFrameGeometry(
        openingWidthMm,
        openingHeightMm,
        pol4508SilverProfile,
      ),
    [openingWidthMm, openingHeightMm],
  );
  return (
    <group>
      <ProfileFrame
        openingWidthMm={openingWidthMm + 2 * accentWidth}
        openingHeightMm={openingHeightMm + 2 * accentWidth}
        materialMode={materialMode}
        moulding={moulding}
        profile={pol4508BlackProfile}
        materialVariant={materialVariant}
      />
      <mesh geometry={silverGeometry} castShadow receiveShadow>
        <ParamountSilverMaterial mode={materialMode} moulding={moulding} />
      </mesh>
    </group>
  );
}
function ParamountSamFrame({
  openingWidthMm,
  openingHeightMm,
  materialMode,
  moulding,
  materialVariant,
}: {
  openingWidthMm: number;
  openingHeightMm: number;
  materialMode: Props["materialMode"];
  moulding: Moulding;
  materialVariant: string;
}) {
  const silverGeometry = useMemo(
    () =>
      createProfileFrameGeometry(
        openingWidthMm,
        openingHeightMm,
        pol4508SamSilverProfile,
      ),
    [openingWidthMm, openingHeightMm],
  );
  return (
    <group>
      <ProfileFrame
        openingWidthMm={openingWidthMm}
        openingHeightMm={openingHeightMm}
        materialMode={materialMode}
        moulding={moulding}
        profile={pol4508SamBlackProfile}
        materialVariant={materialVariant}
      />
      <mesh geometry={silverGeometry} castShadow receiveShadow>
        <ParamountSilverMaterial mode={materialMode} moulding={moulding} />
      </mesh>
    </group>
  );
}
function ParamountCatalogueFrame({
  openingWidthMm,
  openingHeightMm,
  materialMode,
  moulding,
  materialVariant,
  profile,
}: {
  openingWidthMm: number;
  openingHeightMm: number;
  materialMode: Props["materialMode"];
  moulding: Moulding;
  materialVariant: string;
  profile: ProfilePoint[];
}) {
  const [silverProfile, blackProfile] = useMemo(
    () => splitProfile(profile, moulding.accentWidthMm || 9.5),
    [profile, moulding.accentWidthMm],
  );
  const silverGeometry = useMemo(
    () =>
      createProfileFrameGeometry(
        openingWidthMm,
        openingHeightMm,
        silverProfile,
      ),
    [openingWidthMm, openingHeightMm, silverProfile],
  );
  return (
    <group>
      <ProfileFrame
        openingWidthMm={openingWidthMm}
        openingHeightMm={openingHeightMm}
        materialMode={materialMode}
        moulding={moulding}
        profile={blackProfile}
        materialVariant={materialVariant}
      />
      <mesh geometry={silverGeometry} castShadow receiveShadow>
        <ParamountSilverMaterial mode={materialMode} moulding={moulding} />
      </mesh>
    </group>
  );
}
function Framing({
  moulding,
  ow,
  oh,
  iw,
  ih,
  geometryMode,
  materialMode,
  materialVariant,
  profileVariant,
  reviewProfile,
}: {
  moulding: Moulding;
  ow: number;
  oh: number;
  iw: number;
  ih: number;
  geometryMode: Props["geometryMode"];
  materialMode: Props["materialMode"];
  materialVariant: string;
  profileVariant: Props["profileVariant"];
  reviewProfile?: Props["reviewProfile"];
}) {
  if (reviewProfile?.length && geometryMode === "Profile" && moulding.supplier === "Centrado")
    return (
      <CentradoFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        profile={reviewProfile}
        materialVariant={materialVariant}
      />
    );
  if (reviewProfile?.length && geometryMode === "Profile")
    return (
      <ProfileFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        profile={reviewProfile}
        materialVariant={materialVariant}
      />
    );
  const supplierProfile =
    moulding.supplier === "Centrado"
      ? centradoProfile(moulding.sku)
      : undefined;
  const catalogueProfile =
    profileVariant === "Catalogue"
      ? mainlineCatalogueProfile(moulding.sku)
      : undefined;
  if (supplierProfile && geometryMode === "Profile")
    return (
      <CentradoFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        profile={supplierProfile}
        materialVariant={materialVariant}
      />
    );
  if (
    catalogueProfile &&
    moulding.sku === "POL-4508" &&
    geometryMode === "Profile"
  )
    return (
      <ParamountCatalogueFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        materialVariant={materialVariant}
        profile={catalogueProfile}
      />
    );
  if (catalogueProfile && geometryMode === "Profile")
    return (
      <ProfileFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        profile={catalogueProfile}
        materialVariant={materialVariant}
      />
    );
  if (
    moulding.sku === "POL-4508" &&
    geometryMode === "Profile" &&
    profileVariant === "SAM 2.1"
  )
    return (
      <ParamountSamFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        materialVariant={materialVariant}
      />
    );
  if (moulding.sku === "POL-4508" && geometryMode === "Profile")
    return (
      <ParamountFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        materialVariant={materialVariant}
      />
    );
  const profiles: Record<string, ProfilePoint[]> = {
    "POL-4875": profileVariant === "SAM 2.1" ? veronaSamProfile : veronaProfile,
    "POL-4100": pol4100Profile,
    "POL-4418": flat54x20Profile,
    "POL-4211": flat54x20Profile,
  };
  const rebateFloor = Math.max(1, moulding.depthMm - moulding.rebateMm);
  const genericFlatProfile: ProfilePoint[] = [
    [0, rebateFloor],
    [Math.min(2, moulding.widthMm * 0.08), rebateFloor],
    [Math.min(3.5, moulding.widthMm * 0.13), moulding.depthMm],
    [moulding.widthMm, moulding.depthMm],
  ];
  const profile =
    reviewProfile ||
    profiles[moulding.sku] ||
    (moulding.renderStatus === "auto-candidate" &&
    moulding.profileType === "flat"
      ? genericFlatProfile
      : undefined);
  if (profile && geometryMode === "Profile")
    return (
      <ProfileFrame
        openingWidthMm={iw / mm}
        openingHeightMm={ih / mm}
        materialMode={materialMode}
        moulding={moulding}
        profile={profile}
        materialVariant={materialVariant}
      />
    );
  const d = moulding.depthMm * mm,
    gold = moulding.accentColor || "#534b40",
    trim = moulding.sku === "4925BG";
  const rails = railSet(ow, oh, iw, ih);
  const line = 0.011,
    inset = 0.018;
  return (
    <group>
      {rails.map((p, i) => (
        <Rail key={i} points={p} moulding={moulding} />
      ))}
      {moulding.profileType === "ornate-scoop" && (
        <group position={[0, 0, d + 0.002]}>
          <group position={[0, 0, 0.006]}>
            {railSet(ow - 0.035, oh - 0.035, iw + 0.1, ih + 0.1).map((p, i) => (
              <Rail
                key={`relief-${i}`}
                points={p}
                moulding={moulding}
                depth={0.012}
              />
            ))}
          </group>
          <group position={[0, 0, 0.021]}>
            {railSet(ow - 0.012, oh - 0.012, ow - 0.054, oh - 0.054).map(
              (p, i) => (
                <Rail
                  key={`outer-bead-${i}`}
                  points={p}
                  moulding={moulding}
                  depth={0.008}
                />
              ),
            )}
          </group>
          <group position={[0, 0, 0.025]}>
            {railSet(iw + 0.075, ih + 0.075, iw + 0.035, ih + 0.035).map(
              (p, i) => (
                <Rail
                  key={`inner-bead-${i}`}
                  points={p}
                  moulding={moulding}
                  depth={0.007}
                />
              ),
            )}
          </group>
        </group>
      )}
      {trim && (
        <group position={[0, 0, d + 0.003]}>
          {[
            [
              [iw, line, 0.008],
              [0, ih / 2 + inset, 0],
            ],
            [
              [iw, line, 0.008],
              [0, -ih / 2 - inset, 0],
            ],
            [
              [line, ih, 0.008],
              [iw / 2 + inset, 0, 0],
            ],
            [
              [line, ih, 0.008],
              [-iw / 2 - inset, 0, 0],
            ],
          ].map(([args, pos], i) => (
            <mesh key={i} position={pos as [number, number, number]}>
              <boxGeometry args={args as [number, number, number]} />
              <RoomPhysicalMaterial
                color={gold}
                metalness={0.72}
                roughness={0.24}
                envMapIntensity={0.3}
              />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}
function Exposure({ value }: { value: number }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMappingExposure = value;
  }, [gl, value]);
  return null;
}
function shadowMap(pad: number, blur: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d")!,
    margin = canvas.width * pad;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.filter = `blur(${blur}px)`;
  context.fillStyle = "#fff";
  context.fillRect(
    margin,
    margin,
    canvas.width - 2 * margin,
    canvas.height - 2 * margin,
  );
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}
function SoftWallShadow({
  width,
  height,
  gap,
  profileDepth,
  lightPosition,
  opacity,
  softness,
  color,
}: {
  width: number;
  height: number;
  gap: number;
  profileDepth: number;
  lightPosition: [number, number, number];
  opacity: number;
  softness: number;
  color: string;
}) {
  const castPad = 0.22,
    contactPad = 0.09,
    castTexture = useMemo(
      () => shadowMap(castPad, Math.max(5, softness * 1.45)),
      [softness],
    ),
    contactTexture = useMemo(() => shadowMap(contactPad, 2.2), []);
  useEffect(
    () => () => {
      castTexture.dispose();
      contactTexture.dispose();
    },
    [castTexture, contactTexture],
  );
  const lightZ = Math.max(1, Math.abs(lightPosition[2])),
    castDistance = gap + profileDepth,
    castX = (-lightPosition[0] / lightZ) * castDistance * 2,
    castY = (-lightPosition[1] / lightZ) * castDistance * 0.82,
    contactX = (-lightPosition[0] / lightZ) * Math.max(gap, 0.004) * 0.55,
    contactY = (-lightPosition[1] / lightZ) * Math.max(gap, 0.004) * 0.24,
    shadowColour = new THREE.Color(color).multiplyScalar(0.46);
  return (
    <group renderOrder={-2}>
      <mesh position={[castX, castY, -Math.max(0.006, gap)]} renderOrder={-2}>
        <planeGeometry
          args={[width * (1 + 2 * castPad), height * (1 + 2 * castPad)]}
        />
        <meshBasicMaterial
          map={castTexture}
          color={shadowColour}
          transparent
          opacity={Math.min(0.72, opacity * 1.35)}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <mesh
        position={[contactX, contactY, -Math.max(0.004, gap * 0.82)]}
        renderOrder={-1}
      >
        <planeGeometry
          args={[width * (1 + 2 * contactPad), height * (1 + 2 * contactPad)]}
        />
        <meshBasicMaterial
          map={contactTexture}
          color={shadowColour}
          transparent
          opacity={Math.min(0.48, opacity * 1.08)}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
function RoomBackdrop({ room, tint }: { room: RoomTemplate; tint: string }) {
  const map = useTexture(room.image),
    { size } = useThree(),
    plane = roomPlaneMetrics(room, size);
  useMemo(() => {
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    map.needsUpdate = true;
  }, [map]);
  return (
    <group renderOrder={-100}>
      <mesh
        position={[plane.centerX, plane.centerY, plane.planeZ]}
        renderOrder={-100}
      >
        <planeGeometry args={[plane.width, plane.height]} />
        <meshBasicMaterial
          map={map}
          toneMapped={false}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
      <mesh
        position={[plane.centerX, plane.centerY, plane.planeZ + 0.005]}
        renderOrder={-99}
      >
        <planeGeometry args={[plane.width, plane.height]} />
        <meshBasicMaterial
          color={tint}
          transparent
          opacity={room.tintOpacity}
          toneMapped={false}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
function ProjectionReporter({
  frameMatrix,
  width,
  height,
  depth,
  report,
}: {
  frameMatrix: THREE.Matrix4;
  width: number;
  height: number;
  depth: number;
  report?: (corners: number[][]) => void;
}) {
  const previous = useRef("");
  useFrame(({ camera }) => {
    if (!report) return;
    const corners = [
      [-width / 2, height / 2, depth],
      [width / 2, height / 2, depth],
      [width / 2, -height / 2, depth],
      [-width / 2, -height / 2, depth],
    ].map(([x, y, z]) => {
      const point = new THREE.Vector3(x, y, z)
        .applyMatrix4(frameMatrix)
        .project(camera);
      return [(point.x + 1) / 2, (1 - point.y) / 2];
    });
    const signature = corners
      .flat()
      .map((value) => value.toFixed(5))
      .join(",");
    if (signature !== previous.current) {
      previous.current = signature;
      report(corners);
    }
  });
  return null;
}
function rectangularRingGeometry(
  outerWidth: number,
  outerHeight: number,
  innerWidth: number,
  innerHeight: number,
) {
  const ring = new THREE.Shape();
  ring.moveTo(-outerWidth / 2, -outerHeight / 2);
  ring.lineTo(outerWidth / 2, -outerHeight / 2);
  ring.lineTo(outerWidth / 2, outerHeight / 2);
  ring.lineTo(-outerWidth / 2, outerHeight / 2);
  ring.closePath();
  const opening = new THREE.Path();
  opening.moveTo(-innerWidth / 2, -innerHeight / 2);
  opening.lineTo(-innerWidth / 2, innerHeight / 2);
  opening.lineTo(innerWidth / 2, innerHeight / 2);
  opening.lineTo(innerWidth / 2, -innerHeight / 2);
  opening.closePath();
  ring.holes.push(opening);
  return new THREE.ShapeGeometry(ring);
}
function mountBevelGeometry(
  faceWidth: number,
  faceHeight: number,
  backWidth: number,
  backHeight: number,
  thickness: number,
) {
  const positions: number[] = [];
  const addQuad = (a: number[], b: number[], c: number[], d: number[]) => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  const fw = faceWidth / 2,
    fh = faceHeight / 2,
    bw = backWidth / 2,
    bh = backHeight / 2;
  addQuad([-fw, fh, 0], [fw, fh, 0], [bw, bh, -thickness], [-bw, bh, -thickness]);
  addQuad([fw, -fh, 0], [-fw, -fh, 0], [-bw, -bh, -thickness], [bw, -bh, -thickness]);
  addQuad([-fw, -fh, 0], [-fw, fh, 0], [-bw, bh, -thickness], [-bw, -bh, -thickness]);
  addQuad([fw, fh, 0], [fw, -fh, 0], [bw, -bh, -thickness], [bw, bh, -thickness]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
function MountBoard({
  outerWidth,
  outerHeight,
  artworkWidth,
  artworkHeight,
  overlap,
  color,
  faceZ,
  thickness,
}: {
  outerWidth: number;
  outerHeight: number;
  artworkWidth: number;
  artworkHeight: number;
  overlap: number;
  color: string;
  faceZ: number;
  thickness: number;
}) {
  const bevelWidth = thickness;
  const faceOpeningWidth = artworkWidth + 2 * bevelWidth;
  const faceOpeningHeight = artworkHeight + 2 * bevelWidth;
  const faceGeometry = useMemo(
    () => rectangularRingGeometry(
      outerWidth + 2 * overlap,
      outerHeight + 2 * overlap,
      faceOpeningWidth,
      faceOpeningHeight,
    ),
    [outerWidth, outerHeight, overlap, faceOpeningWidth, faceOpeningHeight],
  );
  const bevelGeometry = useMemo(
    () => mountBevelGeometry(
      faceOpeningWidth,
      faceOpeningHeight,
      artworkWidth,
      artworkHeight,
      thickness,
    ),
    [faceOpeningWidth, faceOpeningHeight, artworkWidth, artworkHeight, thickness],
  );
  useEffect(() => () => {
    faceGeometry.dispose();
    bevelGeometry.dispose();
  }, [faceGeometry, bevelGeometry]);
  return (
    <group position={[0, 0, faceZ]}>
      <mesh geometry={faceGeometry} castShadow receiveShadow>
        <RoomStandardMaterial color={color} roughness={0.88} />
      </mesh>
      <mesh geometry={bevelGeometry} castShadow receiveShadow>
        <RoomStandardMaterial
          color="#fffefa"
          emissive="#4a4842"
          emissiveIntensity={0.16}
          roughness={1}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

/** Keeps the measured rebate readable under broad, almost frontal light. */
function RebateContactShadow({
  openingWidth,
  openingHeight,
  faceZ,
  rebateMm,
}: {
  openingWidth: number;
  openingHeight: number;
  faceZ: number;
  rebateMm: number;
}) {
  const reach = THREE.MathUtils.clamp(rebateMm * 0.14, 1.4, 3.4) * mm;
  const rings = useMemo(() => {
    const stops = [0, 0.24, 0.58, 1];
    return stops.slice(0, -1).map((start, index) => ({
      geometry: rectangularRingGeometry(
        openingWidth - 2 * reach * start,
        openingHeight - 2 * reach * start,
        openingWidth - 2 * reach * stops[index + 1],
        openingHeight - 2 * reach * stops[index + 1],
      ),
      opacity: [0.2, 0.105, 0.045][index],
    }));
  }, [openingWidth, openingHeight, reach]);
  useEffect(
    () => () => rings.forEach(({ geometry }) => geometry.dispose()),
    [rings],
  );
  return (
    <group name="render-debug" position={[0, 0, faceZ + 0.00012]}>
      {rings.map(({ geometry, opacity }, index) => (
        <mesh key={index} geometry={geometry} renderOrder={4 + index}>
          <meshBasicMaterial
            color="#17130f"
            transparent
            opacity={opacity}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}
function Scene(p: Props) {
  const { size } = useThree();
  const product = useRef<THREE.Group>(null);
  useEffect(() => {
    p.onExportReady?.(async () => {
      if (!product.current) throw new Error("The frame is still loading.");
      product.current.updateWorldMatrix(true, true);
      const copy = product.current.clone(true);
      const remove: THREE.Object3D[] = [];
      const materials = new Map<THREE.Material, THREE.Material>();
      const exportMaterial = (material: THREE.Material) => {
        if (!materials.has(material)) {
          const cloned = material.clone();
          cloned.name = `export-material-${material.uuid}`;
          materials.set(material, cloned);
        }
        return materials.get(material)!;
      };
      copy.traverse((node: any) => {
        if (node.isLine || node.name === "render-debug" || (node.isMesh && (Array.isArray(node.material) ? node.material : [node.material]).some((m: any) => m.isShadowMaterial))) remove.push(node);
      });
      remove.forEach(node => node.removeFromParent());
      copy.traverse((node: any) => {
        if (node.isMesh) node.material = Array.isArray(node.material) ? node.material.map(exportMaterial) : exportMaterial(node.material);
      });
      return await new GLTFExporter().parseAsync(copy, { binary: true, onlyVisible: true }) as ArrayBuffer;
    });
    return () => p.onExportReady?.(null);
  }, [p.onExportReady]);
  const m = p.moulding,
    aw = p.artWidth * mm,
    ah = p.artHeight * mm,
    mt = p.mount * mm,
    experimental4508 = m.sku === "POL-4508" && p.profileVariant === "SAM 2.1",
    catalogueCandidate =
      p.profileVariant === "Catalogue" && !!mainlineCatalogueProfile(m.sku),
    includedAccent =
      m.supplier === "Centrado" || experimental4508 || catalogueCandidate,
    fw = (m.widthMm + (includedAccent ? 0 : m.accentWidthMm || 0)) * mm,
    ow = aw + 2 * (mt + fw),
    oh = ah + 2 * (mt + fw),
    iw = aw + 2 * mt,
    ih = ah + 2 * mt,
    // The mount is physically larger than the sight opening and sits beneath
    // the rebate. Overscanning it prevents the room behind the frame becoming
    // visible through the opening when the assembly is viewed at an angle.
    rebateOverlap = Math.min(8, Math.max(3, m.rebateMm * 0.35)) * mm;
  const art = useTexture(p.artwork);
  art.colorSpace = THREE.SRGBColorSpace;
  const light = {
    "Studio Soft": [3, 4, 5, 1.2, "#fff7e8"],
    "Window Left": [-4, 3, 4, 2.1, "#e4efff"],
    "Warm Interior": [2, 2, 3, 1.6, "#ffd4a2"],
    "Dramatic Raking Light": [-5, 0.7, 2, 2.8, "#e9e0c8"],
  }[p.lighting] || [3, 4, 5, 1, "#fff"];
  const wall = p.displayMode === "Wall",
    generatedRoom = wall && p.roomTemplate?.kind === "generated",
    baseRoom = p.roomTemplate || roomPresets[p.wallPreset] || fallbackRoom,
    room = {
      ...baseRoom,
      camera: {
        ...baseRoom.camera,
        fov:
          p.roomCalibration?.renderer?.cameraFovDegrees || baseRoom.camera.fov,
      },
    },
    calibratedLighting = p.roomCalibration?.renderer?.lighting;
  const detailTarget: [number, number, number] = [ow * 0.38, oh * 0.36, 0],
    orbitTarget: [number, number, number] =
      p.view === "Detail" && !wall ? detailTarget : wall && room.camera.target ? room.camera.target : [0, wall ? 0.1 : 0, 0];
  const cam = wall
    ? room.camera.position
    : p.view === "Review"
      ? [0, 0, 4.2]
      : p.view === "Front"
        ? [0, 0, 3.75]
        : p.view === "Detail"
          ? [detailTarget[0] + 0.34, detailTarget[1] + 0.24, 0.9]
          : [ow * 0.35, oh * 0.22, 3.05];
  const cameraResetKey = `${p.displayMode}-${p.view}-${p.wallPreset}-${p.artWidth}-${p.artHeight}`;
  // Mount widths and moulding changes alter the physical frame but must not
  // reset a camera the user has already orbited or panned. Re-seed only for a
  // genuinely new view.
  const stableCameraPosition = useMemo(() => cam, [cameraResetKey]);
  const stableOrbitTarget = useMemo(() => orbitTarget, [cameraResetKey]);
  // All catalogue mouldings carry a measured rebate. The mounted package sits
  // just behind its inner lip so the existing rebate wall remains visible at
  // oblique angles instead of merging with the mount into one flat plane.
  const rebateLipZ = Math.max(1, m.depthMm - m.rebateMm) * mm,
    packageSetbackMm = THREE.MathUtils.clamp(m.rebateMm * 0.12, 0.8, 2.4),
    packageFaceZ = Math.max(0.0082, rebateLipZ - packageSetbackMm * mm),
    mountThickness = 2 * mm,
    mountFaceZ = packageFaceZ,
    innerMountReveal = p.mount > 0 ? Math.max(0, p.innerMount) * mm : 0,
    hasInnerMount = innerMountReveal > 0,
    innerMountFaceZ = mountFaceZ - mountThickness - 0.00003,
    artZ = p.mount > 0
      ? (hasInnerMount ? innerMountFaceZ : mountFaceZ) -
        mountThickness -
        0.00003
      : packageFaceZ,
    glassZ = Math.min(
      rebateLipZ - 0.25 * mm,
      (p.mount > 0 ? mountFaceZ : packageFaceZ) + 0.65 * mm,
    );
  const rearClosureFace = Math.min(.008, artZ - .0005);
  let frameMatrix = new THREE.Matrix4();
  if (wall) {
    frameMatrix.compose(
      new THREE.Vector3(
        room.framePosition[0] + p.wallPositionX * 1.35,
        room.framePosition[1] + p.wallPositionY * 0.8,
        room.framePosition[2],
      ),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(...room.frameRotation),
      ),
      new THREE.Vector3(
        room.frameScale * p.wallScale,
        room.frameScale * p.wallScale,
        room.frameScale * p.wallScale,
      ),
    );
  }
  const approvedQuad = p.roomCalibration?.manualCalibration?.quadNormalised;
  if (wall && room.imageAspect && approvedQuad?.length === 4) {
    const pose = calibratedFramePose(
      approvedQuad,
      size,
      room,
      p.roomCalibration,
      p.roomImageFit,
    );
    frameMatrix = pose.matrix.clone();
    const position = new THREE.Vector3().setFromMatrixPosition(frameMatrix),
      axisX = new THREE.Vector3().setFromMatrixColumn(frameMatrix, 0),
      axisY = new THREE.Vector3().setFromMatrixColumn(frameMatrix, 1);
    position
      .addScaledVector(axisX, p.wallPositionX * 1.35)
      .addScaledVector(axisY, p.wallPositionY * 0.8);
    frameMatrix
      .setPosition(position)
      .multiply(
        new THREE.Matrix4().makeScale(p.wallScale, p.wallScale, p.wallScale),
      );
  }
  const activeLight = wall
    ? calibratedLighting
      ? {
          position: [
            calibratedLighting.azimuth * 5,
            1 + calibratedLighting.elevation * 5,
            4.5,
          ] as [number, number, number],
          intensity: room.keyLight.intensity * calibratedLighting.keyStrength,
          color: temperatureColour(calibratedLighting.temperature),
        }
      : room.keyLight
    : {
        position: light.slice(0, 3) as [number, number, number],
        intensity: light[3] as number,
        color: light[4] as string,
      };
  const ambientStrength = calibratedLighting?.ambientStrength ?? 1,
    shadowOpacity = calibratedLighting?.shadowOpacity ?? room.shadow.opacity,
    shadowRadius = calibratedLighting?.shadowSoftness ?? room.shadow.radius,
    shadowGap = (calibratedLighting?.shadowGapMm ?? 4) * mm;
  return (
    <>
      <Exposure value={p.exposure * (wall && !generatedRoom ? 1.22 : 1)} />
      {!p.overlayOnly && <color attach="background" args={[p.wallColour]} />}
      {generatedRoom ? <GeneratedRoomLighting sceneId={room.sceneId!} strength={p.lightStrength} fill={p.ambientFill} shadow={p.wallShadow} depthMm={m.depthMm} /> : <>
      <ambientLight
        intensity={
          (wall ? Math.max(0.72, room.ambient * ambientStrength) : 0.32) *
          p.ambientFill
        }
      />
      {wall && (
        <>
          <hemisphereLight
            args={[
              "#fffaf1",
              "#837b70",
              0.42 * ambientStrength * p.ambientFill,
            ]}
          />
          <directionalLight
            position={[-activeLight.position[0] * 0.55, 2.2, 3.8]}
            intensity={0.28 * ambientStrength * p.ambientFill}
            color="#e7eef5"
          />
          <rectAreaLight
            position={activeLight.position}
            intensity={activeLight.intensity * p.lightStrength * 1.15}
            color={activeLight.color}
            width={3.8}
            height={3.8}
          />
        </>
      )}
      <directionalLight
        position={activeLight.position}
        intensity={activeLight.intensity * p.lightStrength * (wall ? 0.82 : 1)}
        color={activeLight.color}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
        shadow-bias={wall ? room.shadow.bias : -0.0001}
        shadow-normalBias={wall ? 0.0007 : 0}
        shadow-radius={wall ? shadowRadius : 3}
      />
      <Environment
        preset="warehouse"
        environmentIntensity={
          (wall ? Math.max(0.5, room.environment * ambientStrength) : 0.38) *
          Math.max(0.7, p.ambientFill)
        }
      />
      </>}
      {wall && !p.overlayOnly && (
        <RoomBackdrop room={room} tint={p.wallColour} />
      )}
      {generatedRoom && <FrameWallContact matrix={frameMatrix} width={ow} height={oh} wallZ={generatedScenes[room.sceneId!].wallZ} strength={p.wallShadow} />}
      <GeneratedMaterialContext.Provider value={generatedRoom}>
      <group ref={product} name="configured-frame"
        matrix={wall ? frameMatrix : new THREE.Matrix4()}
        matrixAutoUpdate={false}
      >
        {generatedRoom && <mesh name="product-rear-closure"
          position={[0, 0, (rearClosureFace + (generatedScenes[room.sceneId!].wallZ + .0002 - room.framePosition[2]) / (room.frameScale * p.wallScale)) / 2]}
          castShadow receiveShadow>
          {/* The swept profile ends at z=.008. Close the remaining stand-off
              to the wall; a shadow overlay cannot hide this visible air gap. */}
          <boxGeometry args={[ow - .001, oh - .001, rearClosureFace - (generatedScenes[room.sceneId!].wallZ + .0002 - room.framePosition[2]) / (room.frameScale * p.wallScale)]} />
          <RoomStandardMaterial color={m.baseColor} roughness={.95} />
        </mesh>}
        {wall && !p.overlayOnly && (
          <SoftWallShadow
            width={ow}
            height={oh}
            gap={shadowGap}
            profileDepth={m.depthMm * mm}
            lightPosition={activeLight.position}
            opacity={Math.min(0.8, shadowOpacity * p.wallShadow)}
            softness={shadowRadius}
            color={room.shadow.color}
          />
        )}
        {p.mount > 0 && (
          <>
            <MountBoard
              outerWidth={iw}
              outerHeight={ih}
              artworkWidth={aw + 2 * innerMountReveal}
              artworkHeight={ah + 2 * innerMountReveal}
              overlap={rebateOverlap}
              color={p.mountColor}
              faceZ={mountFaceZ}
              thickness={mountThickness}
            />
            {hasInnerMount && (
              <MountBoard
                outerWidth={iw}
                outerHeight={ih}
                artworkWidth={aw}
                artworkHeight={ah}
                overlap={rebateOverlap}
                color={p.innerMountColor}
                faceZ={innerMountFaceZ}
                thickness={mountThickness}
              />
            )}
          </>
        )}
        <mesh name="product-artwork" position={[0, 0, artZ]} receiveShadow>
          <planeGeometry args={[aw, ah]} />
          {generatedRoom && p.artworkColourMode === "Room lighting"
            ? <RoomStandardMaterial map={art} roughness={.95} metalness={0} envMapIntensity={.55} toneMapped={false} />
            : <meshBasicMaterial map={art} toneMapped={false} />}
        </mesh>
        {((generatedRoom && p.artworkColourMode !== "Room lighting") || (p.mount > 0 && !generatedRoom)) && (
          <mesh position={[0, 0, artZ + 0.00005]} receiveShadow renderOrder={3}>
            <planeGeometry args={[aw, ah]} />
            <shadowMaterial
              transparent
              opacity={generatedRoom ? 0.16 : 0.22}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        )}
        <RebateContactShadow
          openingWidth={iw}
          openingHeight={ih}
          faceZ={p.mount > 0 ? mountFaceZ : artZ}
          rebateMm={m.rebateMm}
        />
        <Framing
          moulding={m}
          ow={ow}
          oh={oh}
          iw={iw}
          ih={ih}
          geometryMode={p.geometryMode}
          materialMode={p.materialMode}
          materialVariant={p.materialRevision ? `${p.materialVariant}@${p.materialRevision}` : p.materialVariant}
          profileVariant={p.profileVariant}
          reviewProfile={p.reviewProfile}
        />
        {p.glass !== "None" && (
          <mesh name="product-glass" position={[0, 0, glassZ]}>
            <planeGeometry args={generatedRoom ? [iw, ih] : [aw, ah]} />
            <meshPhysicalMaterial
              transparent
              opacity={generatedRoom ? (p.glass === "Museum" ? .008 : .035) : p.glass === "Museum" ? 0.07 : 0.16}
              roughness={generatedRoom ? .045 : p.glass === "Museum" ? 0.06 : 0.19}
              metalness={generatedRoom ? 0 : 0.05}
              clearcoat={1}
              envMapIntensity={generatedRoom ? .45 : 1}
            />
          </mesh>
        )}
        {p.debug && (
          <>
            <lineSegments>
              <edgesGeometry
                args={[new THREE.BoxGeometry(ow, oh, m.depthMm * mm)]}
              />
              <lineBasicMaterial color="#e3b65f" />
            </lineSegments>
            <Text name="render-debug"
              position={[0, -oh / 2 - 0.12, 0.04]}
              fontSize={0.035}
              color="#d9b86f"
            >{`${Math.round(ow / mm)} × ${Math.round(oh / mm)} mm`}</Text>
          </>
        )}
      </group>
      </GeneratedMaterialContext.Provider>
      {wall && (
        <ProjectionReporter
          frameMatrix={frameMatrix}
          width={ow}
          height={oh}
          depth={m.depthMm * mm}
          report={p.onWallProjection}
        />
      )}
      {!wall && (
        <ContactShadows
          position={[0, -1.1, -0.2]}
          opacity={0.45}
          scale={6}
          blur={2.5}
        />
      )}
      <OrbitControls
        key={`controls-${cameraResetKey}`}
        target={stableOrbitTarget}
        enableRotate={!wall}
        enablePan={!wall}
        enableZoom={!wall}
        screenSpacePanning={!wall}
        minDistance={wall ? 7.2 : p.view === "Detail" ? 0.42 : 1.05}
        maxDistance={wall ? 11 : 4.2}
        minPolarAngle={Math.PI * 0.36}
        maxPolarAngle={Math.PI * 0.64}
      />
      <PerspectiveCamera
        key={`camera-${cameraResetKey}`}
        makeDefault
        position={stableCameraPosition as [number, number, number]}
        fov={generatedRoom
          ? fittedRoomFov(room.camera.fov, room.imageAspect!, size.width / Math.max(1, size.height), p.roomImageFit || "contain")
          : wall ? room.camera.fov : p.view === "Detail" ? 31 : 33}
      />
    </>
  );
}
export default function FramedArtwork(p: Props) {
  const generatedRoom = p.displayMode === "Wall" && p.roomTemplate?.kind === "generated";
  const lighting = p.roomCalibration?.renderer?.lighting;
  const match = THREE.MathUtils.clamp(p.roomMatchStrength, 0, 1);
  const brightness = 1 + ((lighting?.foregroundBrightness ?? 0.82) - 1) * match;
  const saturation = 1 + ((lighting?.foregroundSaturation ?? 0.82) - 1) * match;
  const warmth = (lighting?.foregroundWarmth ?? 0) * match;
  const compositeFilter = p.overlayOnly && !generatedRoom
    ? `brightness(${brightness}) saturate(${saturation}) sepia(${Math.max(0, warmth) * 0.18}) hue-rotate(${Math.min(0, warmth) * 8}deg)`
    : undefined;
  return (
    <Canvas
      key={generatedRoom ? "generated-room-soft-daylight" : p.overlayOnly ? "wall-overlay" : "opaque-scene"}
      className="canvas"
      frameloop={generatedRoom ? "demand" : "always"}
      style={{ filter: compositeFilter }}
      shadows={{ type: generatedRoom ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap }}
      dpr={[1, 2]}
      gl={{
        toneMapping: generatedRoom ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping,
        outputColorSpace: THREE.SRGBColorSpace,
        alpha: !!p.overlayOnly,
      }}
      onCreated={({ gl }) => {
        if (p.overlayOnly) gl.setClearColor(0x000000, 0);
      }}
    >
      <CameraPoseReporter />
      <Scene {...p} />
    </Canvas>
  );
}
