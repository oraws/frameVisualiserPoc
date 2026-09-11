import { useEffect, useMemo, useRef, useState } from "react";
import {
  roomAdminRooms,
  roomCalibrationKey,
  roomPreviewKey,
  roomVisibilityKey,
  type RoomAdminDefinition,
} from "../renderer/roomAdminRegistry";
import {
  customRoomImageUrl,
  listCustomRooms,
  saveCustomRoom,
} from "../renderer/customRoomStore";
import {
  clampWindowLightStrength,
  MAX_WINDOW_LIGHT_STRENGTH,
  windowLightBand,
} from "../renderer/windowLight";

type Point = { x: number; y: number };
type Draft = {
  roomId: string;
  status: string;
  sourceDimensions: { width: number; height: number };
  geometry: {
    model: string;
    commercialDeploymentAllowed: boolean;
    device: string;
    inferenceSeconds: number;
    camera: { horizontalFovDegrees: number };
    wallHypothesis: {
      yawDegrees: number;
      pitchDegrees: number;
      ransacInlierFraction: number;
      residualP95ModelUnits: number;
    };
  };
  manualCalibration: {
    quadNormalised: number[][];
    frameCentreNormalised?: number[];
    scaleReference?: {
      label: string;
      lengthMm: number;
      pointsNormalised: number[][];
    };
  };
  lighting: {
    status: string;
    dominantImagePoint: number[];
    exposureClippedFraction: number;
    rendererUseAllowed: boolean;
  };
  renderer?: {
    cameraFovDegrees?: number;
    wallYawDegrees?: number;
    wallPitchDegrees?: number;
    perspectiveMode?: string;
    lighting?: LightingControls;
  };
};
type LightingControls = {
  azimuth: number;
  elevation: number;
  keyStrength: number;
  ambientStrength: number;
  temperature: number;
  shadowOpacity: number;
  shadowSoftness: number;
  shadowGapMm: number;
  goboEnabled: boolean;
  goboAngle: number;
  goboScale: number;
  goboOffsetX: number;
  goboOffsetY: number;
  goboStrength: number;
  goboSoftness: number;
  foregroundBrightness: number;
  foregroundSaturation: number;
  foregroundWarmth: number;
};

const defaultScaleReference = {
  label: "Target-wall floor to ceiling",
  lengthMm: 2400,
  pointsNormalised: [
    [0.12, 0.18],
    [0.12, 0.72],
  ],
};
const defaultLighting: LightingControls = {
  azimuth: -0.55,
  elevation: 0.65,
  keyStrength: 1,
  ambientStrength: 0.72,
  temperature: 4400,
  shadowOpacity: 0.34,
  shadowSoftness: 10,
  shadowGapMm: 10,
  goboEnabled: false,
  goboAngle: -24,
  goboScale: 1,
  goboOffsetX: 0,
  goboOffsetY: 0,
  goboStrength: 0.05,
  goboSoftness: 8,
  foregroundBrightness: 0.82,
  foregroundSaturation: 0.82,
  foregroundWarmth: 0,
};

function normaliseLighting(
  lighting?: Partial<LightingControls>,
): LightingControls {
  const merged = { ...defaultLighting, ...lighting };
  return {
    ...merged,
    goboStrength: clampWindowLightStrength(merged.goboStrength),
  };
}
type AdminRoom = RoomAdminDefinition & {
  draftRecord?: Draft;
  custom?: boolean;
  imageAspect?: number;
};

function createUploadDraft(id: string, width: number, height: number): Draft {
  return {
    roomId: id,
    status: "uploaded-awaiting-approval",
    sourceDimensions: { width, height },
    geometry: {
      model: "manual room upload seed",
      commercialDeploymentAllowed: true,
      device: "browser upload",
      inferenceSeconds: 0,
      camera: { horizontalFovDegrees: 55 },
      wallHypothesis: {
        yawDegrees: 0,
        pitchDegrees: 0,
        ransacInlierFraction: 0.5,
        residualP95ModelUnits: 0,
      },
    },
    manualCalibration: {
      quadNormalised: [
        [0.15, 0.18],
        [0.85, 0.18],
        [0.85, 0.78],
        [0.15, 0.78],
      ],
      frameCentreNormalised: [0.5, 0.5],
      scaleReference: defaultScaleReference,
    },
    lighting: {
      status: "LDR direction proxy",
      dominantImagePoint: [0.25, 0.2],
      exposureClippedFraction: 0,
      rendererUseAllowed: false,
    },
  };
}

function homography(points: Point[]) {
  const [p0, p1, p2, p3] = points;
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x,
    sy = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  let g = 0,
    h = 0;
  if (Math.abs(denominator) > 1e-8) {
    g = (sx * dy2 - dx2 * sy) / denominator;
    h = (dx1 * sy - sx * dy1) / denominator;
  }
  const a = p1.x - p0.x + g * p1.x,
    b = p3.x - p0.x + h * p3.x,
    c = p0.x;
  const d = p1.y - p0.y + g * p1.y,
    e = p3.y - p0.y + h * p3.y,
    f = p0.y;
  return (u: number, v: number) => {
    const q = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / q, y: (d * u + e * v + f) / q };
  };
}

function homographyMatrix(points: Point[]) {
  const [p0, p1, p2, p3] = points;
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x,
    sy = p0.y - p1.y + p2.y - p3.y,
    denominator = dx1 * dy2 - dx2 * dy1;
  const g =
      Math.abs(denominator) > 1e-8 ? (sx * dy2 - dx2 * sy) / denominator : 0,
    h = Math.abs(denominator) > 1e-8 ? (dx1 * sy - sx * dy1) / denominator : 0;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
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
function matrixPoint(m: number[], point: Point) {
  const q = m[6] * point.x + m[7] * point.y + m[8];
  return {
    x: (m[0] * point.x + m[1] * point.y + m[2]) / q,
    y: (m[3] * point.x + m[4] * point.y + m[5]) / q,
  };
}
function temperatureCss(kelvin: number) {
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
  return `rgb(${Math.round(Math.max(0, Math.min(255, r)))},${Math.round(Math.max(0, Math.min(255, g)))},${Math.round(Math.max(0, Math.min(255, b)))})`;
}

function polyline(
  project: (u: number, v: number) => Point,
  constant: number,
  vertical: boolean,
  steps = 24,
) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    const point = vertical ? project(constant, t) : project(t, constant);
    return `${point.x},${point.y}`;
  }).join(" ");
}

export default function RoomCalibrator() {
  const initialRoomId =
    new URLSearchParams(window.location.search).get("room") || "stock-pilot";
  const [roomId, setRoomId] = useState(initialRoomId);
  const [adminRooms, setAdminRooms] = useState<AdminRoom[]>(roomAdminRooms);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [scalePoints, setScalePoints] = useState<Point[]>([]);
  const [frameCentre, setFrameCentre] = useState<Point>({ x: 0.5, y: 0.5 });
  const [referenceMm, setReferenceMm] = useState(2400);
  const [cameraFov, setCameraFov] = useState(55);
  const [roomLighting, setRoomLighting] =
    useState<LightingControls>(defaultLighting);
  const [active, setActive] = useState<{
    kind: "plane" | "scale" | "centre";
    index: number;
  } | null>(null);
  const [checks, setChecks] = useState([false, false, false]);
  const [saved, setSaved] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [visible, setVisible] = useState(true);
  const [uploadName, setUploadName] = useState("My room");
  const [uploadSource, setUploadSource] = useState("");
  const svgRef = useRef<SVGSVGElement>(null);
  const selectedRoom = adminRooms.find((room) => room.id === roomId);
  const calibrationKey = roomCalibrationKey(roomId);
  const previewKey = roomPreviewKey(roomId);

  useEffect(() => {
    listCustomRooms()
      .then((rooms) =>
        setAdminRooms([
          ...roomAdminRooms,
          ...rooms.map((room) => ({
            id: room.id,
            name: room.name,
            image: customRoomImageUrl(room),
            draft: "",
            sourceUrl: room.sourceUrl || "",
            credit: "Uploaded room",
            custom: true,
            imageAspect: room.width / room.height,
            draftRecord: createUploadDraft(room.id, room.width, room.height),
          })),
        ]),
      )
      .catch(() => {
        /* IndexedDB may be unavailable in private contexts */
      });
  }, []);

  useEffect(() => {
    if (!selectedRoom) return;
    setDraft(null);
    setSaved(false);
    setChecks([false, false, false]);
    setVisible(localStorage.getItem(roomVisibilityKey(roomId)) !== "false");
    window.history.replaceState({}, "", `/room-calibrator/?room=${roomId}`);
    const loadRecord = selectedRoom.draftRecord
      ? Promise.resolve(selectedRoom.draftRecord)
      : fetch(selectedRoom.draft).then((response) => response.json());
    loadRecord.then((record: Draft) => {
      setDraft(record);
      const stored =
        localStorage.getItem(previewKey) ||
        localStorage.getItem(calibrationKey);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (
            (parsed.approved || parsed.preview) &&
            parsed.manualCalibration?.quadNormalised
          ) {
            setPoints(
              parsed.manualCalibration.quadNormalised.map(
                ([x, y]: number[]) => ({ x, y }),
              ),
            );
            const scale =
              parsed.manualCalibration.scaleReference ||
              record.manualCalibration.scaleReference ||
              defaultScaleReference;
            setScalePoints(
              scale.pointsNormalised.map(([x, y]: number[]) => ({ x, y })),
            );
            const centre = parsed.manualCalibration.frameCentreNormalised ||
              record.manualCalibration.frameCentreNormalised || [0.5, 0.5];
            setFrameCentre({ x: centre[0], y: centre[1] });
            setCameraFov(
              parsed.renderer?.cameraFovDegrees ||
                record.geometry.camera.horizontalFovDegrees,
            );
            setRoomLighting(normaliseLighting(parsed.renderer?.lighting));
            setReferenceMm(scale.lengthMm);
            setChecks(parsed.adminChecks || [true, true, true]);
            setSaved(parsed.approved === true);
            return;
          }
        } catch {
          /* keep draft */
        }
      }
      setPoints(
        record.manualCalibration.quadNormalised.map(([x, y]) => ({ x, y })),
      );
      const scale =
        record.manualCalibration.scaleReference || defaultScaleReference;
      setScalePoints(scale.pointsNormalised.map(([x, y]) => ({ x, y })));
      const centre = record.manualCalibration.frameCentreNormalised || [
        0.5, 0.5,
      ];
      setFrameCentre({ x: centre[0], y: centre[1] });
      setCameraFov(
        record.renderer?.cameraFovDegrees ||
          record.geometry.camera.horizontalFovDegrees,
      );
      setRoomLighting(normaliseLighting(record.renderer?.lighting));
      setReferenceMm(scale.lengthMm);
    });
  }, [roomId, adminRooms.length]);

  const project = useMemo(
    () => (points.length === 4 ? homography(points) : null),
    [points],
  );
  const previewGeometry = useMemo(() => {
    if (points.length !== 4 || scalePoints.length !== 2 || referenceMm <= 0)
      return null;
    const inverse = inverse3(homographyMatrix(points));
    if (!inverse) return null;
    const a = matrixPoint(inverse, scalePoints[0]),
      b = matrixPoint(inverse, scalePoints[1]),
      sourcePerMm = Math.hypot(b.x - a.x, b.y - a.y) / referenceMm;
    const outerWidth = 994 * sourcePerMm,
      outerHeight = 794 * sourcePerMm,
      mountWidth = 800 * sourcePerMm,
      mountHeight = 600 * sourcePerMm,
      artWidth = 700 * sourcePerMm,
      artHeight = 500 * sourcePerMm;
    const corners = (width: number, height: number, dx = 0, dy = 0) =>
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([sx, sy]) =>
        project!(
          frameCentre.x + dx + (sx * width) / 2,
          frameCentre.y + dy + (sy * height) / 2,
        ),
      );
    const shadowScale =
        (roomLighting.shadowGapMm / Math.max(referenceMm, 1)) * 4,
      shadowDx = -roomLighting.azimuth * shadowScale,
      shadowDy = Math.max(0.15, roomLighting.elevation) * shadowScale;
    return {
      outer: corners(outerWidth, outerHeight),
      mount: corners(mountWidth, mountHeight),
      art: corners(artWidth, artHeight),
      shadow: corners(outerWidth, outerHeight, shadowDx, shadowDy),
    };
  }, [points, scalePoints, referenceMm, frameCentre, roomLighting, project]);
  const previewCompositeFilter = `brightness(${roomLighting.foregroundBrightness}) saturate(${roomLighting.foregroundSaturation}) sepia(${Math.max(0, roomLighting.foregroundWarmth) * 0.18}) hue-rotate(${Math.min(0, roomLighting.foregroundWarmth) * 8}deg)`;
  const previewGoboBand = windowLightBand(roomLighting);
  const allChecked = checks.every(Boolean);
  const pointerPoint = (event: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  const move = (event: React.PointerEvent) => {
    if (active === null) return;
    const next = pointerPoint(event);
    setSaved(false);
    const bounded = {
      x: Math.max(0, Math.min(1, next.x)),
      y: Math.max(0, Math.min(1, next.y)),
    };
    if (active.kind === "plane")
      setPoints((current) =>
        current.map((point, index) =>
          index === active.index ? bounded : point,
        ),
      );
    else if (active.kind === "scale")
      setScalePoints((current) =>
        current.map((point, index) =>
          index === active.index ? bounded : point,
        ),
      );
    else if (project) {
      let closest = { point: { x: 0.5, y: 0.5 }, distance: Infinity };
      for (let y = 0; y <= 1; y += 0.02)
        for (let x = 0; x <= 1; x += 0.02) {
          const candidate = project(x, y),
            distance = Math.hypot(
              candidate.x - bounded.x,
              candidate.y - bounded.y,
            );
          if (distance < closest.distance)
            closest = { point: { x, y }, distance };
        }
      setFrameCentre(closest.point);
    }
  };
  const calibrationRecord = (approved: boolean) =>
    draft && {
      ...draft,
      status: approved ? "geometry-and-lighting-approved" : "admin-preview",
      approved,
      preview: !approved,
      rendererUseAllowed: approved,
      adminChecks: checks,
      ...(approved ? { approvedAt: new Date().toISOString() } : {}),
      visibleInVisualizer: visible,
      manualCalibration: {
        ...draft.manualCalibration,
        quadNormalised: points.map((point) => [
          Number(point.x.toFixed(6)),
          Number(point.y.toFixed(6)),
        ]),
        frameCentreNormalised: [
          Number(frameCentre.x.toFixed(4)),
          Number(frameCentre.y.toFixed(4)),
        ],
        scaleReference: {
          label: "Target-wall floor to ceiling",
          lengthMm: referenceMm,
          pointsNormalised: scalePoints.map((point) => [
            Number(point.x.toFixed(6)),
            Number(point.y.toFixed(6)),
          ]),
        },
        reviewedAt: new Date().toISOString(),
        reviewer: "local-review",
      },
      renderer: {
        cameraFovDegrees: cameraFov,
        perspectiveMode: "calibrated-quad",
        quadNormalised: points.map((point) => [
          Number(point.x.toFixed(6)),
          Number(point.y.toFixed(6)),
        ]),
        lightingMode: "admin-directional-light",
        lighting: roomLighting,
      },
    };
  const livePreviewSignature = useMemo(
    () =>
      JSON.stringify({
        roomId,
        points,
        scalePoints,
        frameCentre,
        referenceMm,
        cameraFov,
        roomLighting,
        checks,
        visible,
      }),
    [
      roomId,
      points,
      scalePoints,
      frameCentre,
      referenceMm,
      cameraFov,
      roomLighting,
      checks,
      visible,
    ],
  );
  useEffect(() => {
    if (!draft || !project) return;
    const timer = window.setTimeout(() => {
      const record = calibrationRecord(false);
      if (!record) return;
      localStorage.setItem(previewKey, JSON.stringify(record));
      setPreviewRevision((current) => current + 1);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [draft, project, previewKey, livePreviewSignature]);
  const approveAndOpen = () => {
    const record = calibrationRecord(true);
    if (!record) return;
    localStorage.setItem(calibrationKey, JSON.stringify(record));
    localStorage.removeItem(previewKey);
    localStorage.setItem(roomVisibilityKey(roomId), String(visible));
    setSaved(true);
    window.location.assign(`/?mode=wall&room=${roomId}`);
  };
  const previewInViewer = () => {
    const record = calibrationRecord(false);
    if (!record) return;
    localStorage.setItem(previewKey, JSON.stringify(record));
    window.location.assign(`/?mode=wall&room=${roomId}&preview=1`);
  };
  const reset = () => {
    if (!draft) return;
    const scale =
      draft.manualCalibration.scaleReference || defaultScaleReference;
    const centre = draft.manualCalibration.frameCentreNormalised || [0.5, 0.5];
    setPoints(
      draft.manualCalibration.quadNormalised.map(([x, y]) => ({ x, y })),
    );
    setFrameCentre({ x: centre[0], y: centre[1] });
    setScalePoints(scale.pointsNormalised.map(([x, y]) => ({ x, y })));
    setReferenceMm(scale.lengthMm);
    setCameraFov(draft.geometry.camera.horizontalFovDegrees);
    setRoomLighting(normaliseLighting(draft.renderer?.lighting));
    setChecks([false, false, false]);
    setSaved(false);
    localStorage.removeItem(calibrationKey);
    localStorage.removeItem(previewKey);
  };
  const setRoomVisibility = (next: boolean) => {
    setVisible(next);
    localStorage.setItem(roomVisibilityKey(roomId), String(next));
    const stored = localStorage.getItem(calibrationKey);
    if (stored)
      try {
        localStorage.setItem(
          calibrationKey,
          JSON.stringify({ ...JSON.parse(stored), visibleInVisualizer: next }),
        );
      } catch {
        /* invalid record remains untouched */
      }
  };
  const updateLighting = (
    key: keyof LightingControls,
    value: number | boolean,
  ) => {
    setRoomLighting((current) => ({
      ...current,
      [key]:
        key === "goboStrength" && typeof value === "number"
          ? clampWindowLightStrength(value)
          : value,
    }));
    setSaved(false);
  };
  const uploadRoom = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const bitmap = await createImageBitmap(file),
      id = `custom-${Date.now().toString(36)}`,
      name =
        uploadName.trim() || file.name.replace(/\.[^.]+$/, "") || "My room",
      record = {
        id,
        name,
        image: file,
        width: bitmap.width,
        height: bitmap.height,
        sourceUrl: uploadSource.trim(),
        createdAt: new Date().toISOString(),
      };
    bitmap.close();
    await saveCustomRoom(record);
    const room: AdminRoom = {
      id,
      name,
      image: customRoomImageUrl(record),
      draft: "",
      sourceUrl: "",
      credit: "Uploaded room",
      custom: true,
      imageAspect: record.width / record.height,
      draftRecord: createUploadDraft(id, record.width, record.height),
    };
    setAdminRooms((current) => [...current, room]);
    setRoomId(id);
    setUploadSource("");
    event.target.value = "";
  };

  if (!selectedRoom || !draft || !project)
    return (
      <main className="cal-loading">Loading reconstruction evidence…</main>
    );
  return (
    <main className="cal-app">
      <section className="cal-workspace">
        <div className="cal-brand">
          ADMIN / ROOM CALIBRATION
          <span>
            {selectedRoom.name.toUpperCase()} · CALIBRATION DRAFT + MANUAL PROOF
          </span>
        </div>
        <div className="cal-workspace-stack">
        <div className="cal-image-wrap">
          <img
            src={selectedRoom.image}
            alt={`${selectedRoom.name} selected for camera, wall and lighting calibration`}
          />
          <svg
            ref={svgRef}
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            onPointerMove={move}
            onPointerUp={() => setActive(null)}
            onPointerCancel={() => setActive(null)}
          >
            <defs>
              <linearGradient
                id="frame-light-preview"
                x1={`${50 - roomLighting.azimuth * 45}%`}
                y1={`${85 - roomLighting.elevation * 70}%`}
                x2={`${50 + roomLighting.azimuth * 45}%`}
                y2={`${15 + roomLighting.elevation * 30}%`}
              >
                <stop offset="0" stopColor="#090909" />
                <stop offset=".58" stopColor="#242322" />
                <stop
                  offset="1"
                  stopColor={temperatureCss(roomLighting.temperature)}
                  stopOpacity={Math.min(
                    0.72,
                    0.18 + roomLighting.keyStrength * 0.2,
                  )}
                />
              </linearGradient>
              <filter
                id="frame-shadow-preview"
                x="-40%"
                y="-40%"
                width="180%"
                height="180%"
              >
                <feGaussianBlur
                  stdDeviation={0.0015 + roomLighting.shadowSoftness * 0.00045}
                />
              </filter>
              <clipPath id="admin-gobo-clip">
                <polygon
                  points={previewGeometry?.outer
                    .map((p) => `${p.x},${p.y}`)
                    .join(" ")}
                />
              </clipPath>
              <linearGradient
                id="admin-gobo-pattern"
                x1="0"
                y1="0"
                x2="1"
                y2="0"
                gradientUnits="objectBoundingBox"
                gradientTransform={`rotate(${roomLighting.goboAngle} .5 .5)`}
              >
                <stop offset="0" stopColor="#000" />
                <stop offset={previewGoboBand.start} stopColor="#000" />
                <stop
                  offset={previewGoboBand.startSoft}
                  stopColor={temperatureCss(roomLighting.temperature)}
                  stopOpacity=".78"
                />
                <stop
                  offset={previewGoboBand.endSoft}
                  stopColor={temperatureCss(roomLighting.temperature)}
                  stopOpacity=".78"
                />
                <stop offset={previewGoboBand.end} stopColor="#000" />
                <stop offset="1" stopColor="#000" />
              </linearGradient>
              <filter id="admin-gobo-blur">
                <feGaussianBlur
                  stdDeviation={
                    0.0008 + roomLighting.goboSoftness * 0.0005
                  }
                />
              </filter>
            </defs>
            {Array.from({ length: 9 }, (_, i) => i / 8).map((value) => (
              <polyline
                key={`v-${value}`}
                points={polyline(project, value, true)}
                className={
                  value === 0 || value === 1 ? "grid-edge" : "grid-line"
                }
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {Array.from({ length: 7 }, (_, i) => i / 6).map((value) => (
              <polyline
                key={`h-${value}`}
                points={polyline(project, value, false)}
                className={
                  value === 0 || value === 1 ? "grid-edge" : "grid-line"
                }
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {previewGeometry && (
              <>
                <polygon
                  points={previewGeometry.shadow
                    .map((p) => `${p.x},${p.y}`)
                    .join(" ")}
                  className="frame-shadow-proxy"
                  style={{ opacity: roomLighting.shadowOpacity }}
                  filter="url(#frame-shadow-preview)"
                />
                <polygon
                  points={previewGeometry.outer
                    .map((p) => `${p.x},${p.y}`)
                    .join(" ")}
                  className="frame-proxy"
                  fill="url(#frame-light-preview)"
                  style={{ filter: previewCompositeFilter }}
                  vectorEffect="non-scaling-stroke"
                />
                {roomLighting.goboEnabled && (
                  <rect
                    width="1"
                    height="1"
                    fill="url(#admin-gobo-pattern)"
                    opacity={Math.min(0.68, roomLighting.goboStrength * 1.15)}
                    clipPath="url(#admin-gobo-clip)"
                    filter="url(#admin-gobo-blur)"
                    style={{ mixBlendMode: "screen" }}
                  />
                )}
                <polygon
                  points={previewGeometry.mount
                    .map((p) => `${p.x},${p.y}`)
                    .join(" ")}
                  className="mount-proxy"
                  style={{ filter: previewCompositeFilter }}
                  vectorEffect="non-scaling-stroke"
                />
                <polygon
                  points={previewGeometry.art
                    .map((p) => `${p.x},${p.y}`)
                    .join(" ")}
                  className="art-proxy"
                  style={{ filter: previewCompositeFilter }}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
            {scalePoints.length === 2 && (
              <line
                x1={scalePoints[0].x}
                y1={scalePoints[0].y}
                x2={scalePoints[1].x}
                y2={scalePoints[1].y}
                className="scale-reference"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {scalePoints.map((point, index) => (
              <circle
                key={`scale-${index}`}
                cx={point.x}
                cy={point.y}
                r=".009"
                className="scale-handle"
                vectorEffect="non-scaling-stroke"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setActive({ kind: "scale", index });
                }}
              />
            ))}
            {points.map((point, index) => (
              <circle
                key={index}
                cx={point.x}
                cy={point.y}
                r=".011"
                className="grid-handle"
                vectorEffect="non-scaling-stroke"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setActive({ kind: "plane", index });
                }}
              />
            ))}
            <circle
              cx={project(frameCentre.x, frameCentre.y).x}
              cy={project(frameCentre.x, frameCentre.y).y}
              r=".012"
              className="centre-handle"
              vectorEffect="non-scaling-stroke"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setActive({ kind: "centre", index: 0 });
              }}
            />
          </svg>
        </div>
        <div className="cal-caption">
          <b>Gold: perspective · cyan: physical scale · pink: frame centre.</b>{" "}
          The calibration proxy is a 700 × 500 mm artwork. The viewer below
          uses your currently selected moulding.
        </div>
        <section className="cal-live-viewer">
          <div className="cal-live-viewer-heading">
            <b>Live visualiser result</b>
            <span>Actual Three.js frame, perspective, lighting and shadow</span>
          </div>
          <iframe
            key={`${roomId}-${previewRevision}`}
            title={`${selectedRoom.name} live visualiser result`}
            src={`/?mode=wall&room=${roomId}&preview=1&embed=1&revision=${previewRevision}`}
          />
        </section>
        </div>
      </section>
      <aside className="cal-panel">
        <nav className="cal-nav">
          <a href={`/?mode=wall&room=${roomId}`}>Viewer</a>
          <span>Room admin</span>
          <a href="/test-centre/">Test centre</a>
        </nav>
        <h1>Wall-plane review</h1>
        <p>
          The automatic result is a proposal. It cannot enter the room list
          until this visual check is approved.
        </p>
        <section className="cal-intake">
          <h2>Add a room image</h2>
          <p>
            Choose a rights-cleared photograph with a large visible wall and
            strong architectural lines.{" "}
            <a
              href="https://www.pexels.com/license/"
              target="_blank"
              rel="noreferrer"
            >
              Pexels licence
            </a>{" "}
            ·{" "}
            <a
              href="https://unsplash.com/license"
              target="_blank"
              rel="noreferrer"
            >
              Unsplash licence
            </a>
          </p>
          <div className="cal-stock-links">
            <a
              href="https://www.pexels.com/search/interior%20blank%20wall/"
              target="_blank"
              rel="noreferrer"
            >
              Browse Pexels ↗
            </a>
            <a
              href="https://unsplash.com/s/photos/interior-blank-wall"
              target="_blank"
              rel="noreferrer"
            >
              Browse Unsplash ↗
            </a>
          </div>
          <label>
            <span>Room name</span>
            <input
              value={uploadName}
              onChange={(event) => setUploadName(event.target.value)}
            />
          </label>
          <label>
            <span>Source page URL (recommended)</span>
            <input
              type="url"
              placeholder="https://…"
              value={uploadSource}
              onChange={(event) => setUploadSource(event.target.value)}
            />
          </label>
          <label className="cal-upload">
            <span>Upload downloaded image</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={uploadRoom}
            />
          </label>
        </section>
        <label className="cal-room-picker">
          <span>Room draft</span>
          <select
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
          >
            {adminRooms.map((room) => (
              <option value={room.id} key={room.id}>
                {room.name}
                {room.custom ? " · uploaded" : ""}
              </option>
            ))}
          </select>
        </label>
        {selectedRoom.sourceUrl && (
          <p className="cal-source">
            <a href={selectedRoom.sourceUrl} target="_blank" rel="noreferrer">
              {selectedRoom.credit} ↗
            </a>
          </p>
        )}
        <div className="cal-status">
          <span>{saved ? "Admin approved" : "Approval required"}</span>
          <b>
            {draft.geometry.inferenceSeconds
              ? `${draft.geometry.inferenceSeconds.toFixed(2)}s CPU inference`
              : "Manual seed"}
          </b>
        </div>
        <dl>
          <div>
            <dt>Geometry</dt>
            <dd>{draft.geometry.model}</dd>
          </div>
          <div>
            <dt>Camera FOV</dt>
            <dd>{draft.geometry.camera.horizontalFovDegrees.toFixed(1)}°</dd>
          </div>
          <div>
            <dt>Wall normal</dt>
            <dd>
              {draft.geometry.wallHypothesis.yawDegrees.toFixed(1)}° yaw ·{" "}
              {draft.geometry.wallHypothesis.pitchDegrees.toFixed(1)}° pitch
            </dd>
          </div>
          <div>
            <dt>Plane inliers</dt>
            <dd>
              {Math.round(
                draft.geometry.wallHypothesis.ransacInlierFraction * 100,
              )}
              %
            </dd>
          </div>
          <div>
            <dt>Lighting</dt>
            <dd>Admin directional estimate</dd>
          </div>
        </dl>
        <section className="cal-scale">
          <h2>Physical scale</h2>
          <p>The cyan handles span floor to ceiling on this wall.</p>
          <label>
            <span>Known distance</span>
            <input
              type="number"
              min="500"
              max="6000"
              step="10"
              value={referenceMm}
              onChange={(event) => {
                setReferenceMm(Number(event.target.value));
                setSaved(false);
              }}
            />
            <b>mm</b>
          </label>
        </section>
        <section className="cal-lighting">
          <h2>Perspective</h2>
          <p>
            The gold quadrilateral is now the single source of truth. The viewer
            reproduces that plane instead of applying a separate guessed wall
            angle.
          </p>
          <AdminRange
            label="Camera field of view"
            value={cameraFov}
            min={28}
            max={80}
            step={1}
            display={`${cameraFov}°`}
            onChange={(value) => {
              setCameraFov(value);
              setSaved(false);
            }}
          />
          <h2>Room lighting</h2>
          <p>
            The frame highlight and wall shadow on the photograph update
            immediately. Use the full viewer for the moulding’s detailed 3D
            response.
          </p>
          <AdminRange
            label="Light left / right"
            value={roomLighting.azimuth}
            min={-1}
            max={1}
            step={0.05}
            display={
              roomLighting.azimuth < -0.08
                ? "Left"
                : roomLighting.azimuth > 0.08
                  ? "Right"
                  : "Centre"
            }
            onChange={(value) => updateLighting("azimuth", value)}
          />
          <AdminRange
            label="Light height"
            value={roomLighting.elevation}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(roomLighting.elevation * 100)}%`}
            onChange={(value) => updateLighting("elevation", value)}
          />
          <AdminRange
            label="Key strength"
            value={roomLighting.keyStrength}
            min={0.2}
            max={2.5}
            step={0.05}
            display={`${Math.round(roomLighting.keyStrength * 100)}%`}
            onChange={(value) => updateLighting("keyStrength", value)}
          />
          <AdminRange
            label="Ambient fill"
            value={roomLighting.ambientStrength}
            min={0.1}
            max={1.5}
            step={0.05}
            display={`${Math.round(roomLighting.ambientStrength * 100)}%`}
            onChange={(value) => updateLighting("ambientStrength", value)}
          />
          <AdminRange
            label="Colour temperature"
            value={roomLighting.temperature}
            min={2700}
            max={7500}
            step={100}
            display={`${roomLighting.temperature}K`}
            onChange={(value) => updateLighting("temperature", value)}
          />
          <AdminRange
            label="Shadow density"
            value={roomLighting.shadowOpacity}
            min={0.05}
            max={0.8}
            step={0.025}
            display={`${Math.round(roomLighting.shadowOpacity * 100)}%`}
            onChange={(value) => updateLighting("shadowOpacity", value)}
          />
          <AdminRange
            label="Shadow softness"
            value={roomLighting.shadowSoftness}
            min={1}
            max={20}
            step={1}
            display={`${roomLighting.shadowSoftness}`}
            onChange={(value) => updateLighting("shadowSoftness", value)}
          />
          <AdminRange
            label="Frame off wall"
            value={roomLighting.shadowGapMm}
            min={2}
            max={35}
            step={1}
            display={`${roomLighting.shadowGapMm} mm`}
            onChange={(value) => updateLighting("shadowGapMm", value)}
          />
          <h2>Foreground room match</h2>
          <p>
            Match the complete framed object to the photograph without changing
            its approved Frame Detail appearance.
          </p>
          <AdminRange
            label="Foreground brightness"
            value={roomLighting.foregroundBrightness}
            min={0.45}
            max={1.2}
            step={0.025}
            display={`${Math.round(roomLighting.foregroundBrightness * 100)}%`}
            onChange={(value) => updateLighting("foregroundBrightness", value)}
          />
          <AdminRange
            label="Foreground saturation"
            value={roomLighting.foregroundSaturation}
            min={0.35}
            max={1.2}
            step={0.025}
            display={`${Math.round(roomLighting.foregroundSaturation * 100)}%`}
            onChange={(value) => updateLighting("foregroundSaturation", value)}
          />
          <AdminRange
            label="Foreground warmth"
            value={roomLighting.foregroundWarmth}
            min={-1}
            max={1}
            step={0.05}
            display={
              roomLighting.foregroundWarmth < -0.05
                ? "Cooler"
                : roomLighting.foregroundWarmth > 0.05
                  ? "Warmer"
                  : "Neutral"
            }
            onChange={(value) => updateLighting("foregroundWarmth", value)}
          />
          <h2>Window-light mask</h2>
          <p>
            An optional gobo adds a soft window-light lift across the rendered
            frame. Unlit areas keep their normal exposure instead of being
            darkened.
          </p>
          <label className="cal-visibility">
            <input
              type="checkbox"
              checked={roomLighting.goboEnabled}
              onChange={(event) =>
                updateLighting("goboEnabled", event.target.checked)
              }
            />
            <span>
              <b>Enable window-light mask</b>
              <small>
                Off by default; use only where the room photograph contains
                directional window light.
              </small>
            </span>
          </label>
          {roomLighting.goboEnabled && (
            <>
              <AdminRange
                label="Gobo angle"
                value={roomLighting.goboAngle}
                min={-90}
                max={90}
                step={1}
                display={`${roomLighting.goboAngle}°`}
                onChange={(value) => updateLighting("goboAngle", value)}
              />
              <AdminRange
                label="Gobo size"
                value={roomLighting.goboScale}
                min={0.5}
                max={2}
                step={0.05}
                display={`${roomLighting.goboScale.toFixed(2)}×`}
                onChange={(value) => updateLighting("goboScale", value)}
              />
              <AdminRange
                label="Gobo horizontal (left / right)"
                value={roomLighting.goboOffsetX}
                min={-1}
                max={1}
                step={0.05}
                display={
                  roomLighting.goboOffsetX === 0
                    ? "Centre"
                    : `${roomLighting.goboOffsetX > 0 ? "Right" : "Left"} ${Math.abs(Math.round(roomLighting.goboOffsetX * 100))}%`
                }
                onChange={(value) => updateLighting("goboOffsetX", value)}
              />
              <AdminRange
                label="Gobo vertical"
                value={roomLighting.goboOffsetY}
                min={-1}
                max={1}
                step={0.05}
                display={`${Math.round(roomLighting.goboOffsetY * 100)}%`}
                onChange={(value) => updateLighting("goboOffsetY", value)}
              />
              <AdminRange
                label="Gobo strength"
                value={roomLighting.goboStrength}
                min={0}
                max={MAX_WINDOW_LIGHT_STRENGTH}
                step={0.001}
                display={`${(roomLighting.goboStrength * 100).toFixed(1)}%`}
                onChange={(value) => updateLighting("goboStrength", value)}
              />
              <AdminRange
                label="Gobo softness"
                value={roomLighting.goboSoftness}
                min={0}
                max={20}
                step={1}
                display={`${roomLighting.goboSoftness}`}
                onChange={(value) => updateLighting("goboSoftness", value)}
              />
            </>
          )}
          <button
            type="button"
            className="cal-preview"
            onClick={previewInViewer}
          >
            Preview detailed frame in visualiser ↗
          </button>
        </section>
        <label className="cal-visibility">
          <input
            type="checkbox"
            checked={visible}
            onChange={(event) => setRoomVisibility(event.target.checked)}
          />
          <span>
            <b>Show in visualiser</b>
            <small>
              Turn this off to retain the calibration in Room Admin without
              offering the room to viewers.
            </small>
          </span>
        </label>
        {roomId === "stock-pilot" ? (
          <div className="cal-evidence">
            <figure>
              <img src="/assets/rooms/stock-pilot/calibration/depth-diagnostic.png" />
              <figcaption>Predicted depth + wall ROI</figcaption>
            </figure>
            <figure>
              <img src="/assets/rooms/stock-pilot/calibration/confidence-diagnostic.png" />
              <figcaption>Model confidence</figcaption>
            </figure>
          </div>
        ) : (
          <div className="cal-warning">
            <b>New room draft</b>
            <span>
              The initial grid follows visible architectural lines. Adjust the
              gold plane and cyan physical reference before approval.
            </span>
          </div>
        )}
        <section className="cal-checks">
          <h2>Approval checks</h2>
          {[
            "Grid lines agree with the ceiling, skirting and door edges",
            "Reference proxy looks vertical and physically attached",
            "Cyan scale reference spans the known floor-to-ceiling distance",
          ].map((label, index) => (
            <label key={label}>
              <input
                type="checkbox"
                checked={checks[index]}
                onChange={(event) =>
                  setChecks((current) =>
                    current.map((value, i) =>
                      i === index ? event.target.checked : value,
                    ),
                  )
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </section>
        <button
          className="cal-approve"
          disabled={!allChecked && !saved}
          onClick={approveAndOpen}
        >
          {saved
            ? "Open approved room in visualiser"
            : "Approve and add to visualiser"}
        </button>
        <p className="cal-save-note">
          For this POC the approved room is saved inside this browser. The
          production app will persist the same record through the admin API and
          database.
        </p>
        <button className="cal-reset" onClick={reset}>
          Reset to automatic draft
        </button>
        <div className="cal-warning">
          <b>Deliberate limitation</b>
          <span>
            The JPEG has{" "}
            {(draft.lighting.exposureClippedFraction * 100).toFixed(1)}% clipped
            highlights, so exact HDR radiance cannot be recovered. This pilot
            uses the observed bright-region direction as a soft-light proxy.
          </span>
        </div>
      </aside>
    </main>
  );
}

function AdminRange({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="cal-range">
      <span>
        {label}
        <b>{display}</b>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
