import { useMemo } from "react";
import type { RoomTemplate } from "./roomTemplates";
import {
  clampWindowLightStrength,
  windowLightBand,
} from "./windowLight";

type Point = { x: number; y: number };
type Lighting = {
  temperature: number;
  azimuth: number;
  elevation: number;
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
};
type Calibration = {
  manualCalibration?: {
    quadNormalised: number[][];
    frameCentreNormalised?: number[];
    scaleReference?: { lengthMm: number; pointsNormalised: number[][] };
  };
  renderer?: { lighting?: Partial<Lighting> };
};
type Props = {
  room: RoomTemplate;
  calibration?: Calibration | null;
  outerWidthMm: number;
  outerHeightMm: number;
  profileDepthMm: number;
  positionX: number;
  positionY: number;
  scale: number;
  strength: number;
  projectedCorners?: number[][] | null;
};

const defaultLighting: Lighting = {
  temperature: 4400,
  azimuth: -0.55,
  elevation: 0.65,
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
};
function temperatureCss(kelvin: number) {
  const warm = Math.max(0, Math.min(1, (6500 - kelvin) / 3300));
  const cool = Math.max(0, Math.min(1, (kelvin - 6500) / 1500));
  const mix = (from: number, to: number, amount: number) =>
    Math.round(from + (to - from) * amount);
  const warmColour = [255, 224, 178];
  const neutralColour = [255, 250, 240];
  const coolColour = [218, 234, 255];
  const colour = warm
    ? neutralColour.map((value, index) =>
        mix(value, warmColour[index], warm),
      )
    : neutralColour.map((value, index) =>
        mix(value, coolColour[index], cool),
      );
  return `rgb(${colour.join(" ")})`;
}
function homography(points: Point[]) {
  const [p0, p1, p2, p3] = points,
    dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    sx = p0.x - p1.x + p2.x - p3.x,
    sy = p0.y - p1.y + p2.y - p3.y,
    denominator = dx1 * dy2 - dx2 * dy1;
  const g =
      Math.abs(denominator) > 1e-8 ? (sx * dy2 - dx2 * sy) / denominator : 0,
    h = Math.abs(denominator) > 1e-8 ? (dx1 * sy - sx * dy1) / denominator : 0,
    a = p1.x - p0.x + g * p1.x,
    b = p3.x - p0.x + h * p3.x,
    c = p0.x,
    d = p1.y - p0.y + g * p1.y,
    e = p3.y - p0.y + h * p3.y,
    f = p0.y;
  return (u: number, v: number) => {
    const q = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / q, y: (d * u + e * v + f) / q };
  };
}
function matrix(points: Point[]) {
  const [p0, p1, p2, p3] = points,
    dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    sx = p0.x - p1.x + p2.x - p3.x,
    sy = p0.y - p1.y + p2.y - p3.y,
    denominator = dx1 * dy2 - dx2 * dy1,
    g = Math.abs(denominator) > 1e-8 ? (sx * dy2 - dx2 * sy) / denominator : 0,
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
  return Math.abs(det) < 1e-10
    ? null
    : [
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
function transform(m: number[], p: Point) {
  const q = m[6] * p.x + m[7] * p.y + m[8];
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / q,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / q,
  };
}
const serialise = (points: Point[]) =>
  points.map((point) => `${point.x},${point.y}`).join(" ");

export default function WallShadowOverlay(p: Props) {
  const lighting = { ...defaultLighting, ...p.calibration?.renderer?.lighting };
  // The admin proxy paints its light over near-black placeholder geometry. On
  // photographic artwork and textured moulding the same alpha is visually much
  // weaker, so convert the control value into a stronger additive lift here.
  // A zero strength still produces no light and the unlit window bars remain
  // transparent under screen blending.
  const goboOpacity = clampWindowLightStrength(lighting.goboStrength) * 1.15;
  const goboBand = windowLightBand(lighting);
  const geometry = useMemo(() => {
    if (p.projectedCorners?.length === 4) {
      const base = p.projectedCorners.map(([x, y]) => ({ x, y }));
      const screenWidth =
        (Math.hypot(base[1].x - base[0].x, base[1].y - base[0].y) +
          Math.hypot(base[2].x - base[3].x, base[2].y - base[3].y)) /
        2;
      const depthRatio =
        (p.profileDepthMm + lighting.shadowGapMm) / Math.max(1, p.outerWidthMm);
      const distance = Math.min(
        0.03,
        Math.max(0.0035, screenWidth * depthRatio * 1.35),
      );
      const castOffset = {
        x: -lighting.azimuth * distance,
        y: Math.max(0.2, lighting.elevation) * distance,
      };
      const contactOffset = { x: castOffset.x * 0.14, y: castOffset.y * 0.14 };
      const shift = (offset: Point) =>
        base.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
      return {
        frame: base,
        cast: shift(castOffset),
        contact: shift(contactOffset),
      };
    }
    const raw = p.calibration?.manualCalibration?.quadNormalised;
    if (!raw || raw.length !== 4) return null;
    const quad = raw.map(([x, y]) => ({ x, y })),
      project = homography(quad),
      inverse = inverse3(matrix(quad));
    if (!inverse) return null;
    const reference = p.calibration?.manualCalibration?.scaleReference || {
        lengthMm: 2400,
        pointsNormalised: [
          [0.12, 0.18],
          [0.12, 0.72],
        ],
      },
      a = transform(inverse, {
        x: reference.pointsNormalised[0][0],
        y: reference.pointsNormalised[0][1],
      }),
      b = transform(inverse, {
        x: reference.pointsNormalised[1][0],
        y: reference.pointsNormalised[1][1],
      }),
      sourcePerMm =
        Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, reference.lengthMm),
      savedCentre = p.calibration?.manualCalibration?.frameCentreNormalised || [
        0.5, 0.5,
      ],
      centre = {
        x: savedCentre[0] + p.positionX * 0.18,
        y: savedCentre[1] - p.positionY * 0.18,
      };
    const corners = (distanceMm: number, factor: number) => {
      const dx = -lighting.azimuth * distanceMm * sourcePerMm * factor,
        dy =
          Math.max(0.18, lighting.elevation) *
          distanceMm *
          sourcePerMm *
          factor;
      return [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([sx, sy]) =>
        project(
          centre.x + dx + (sx * p.outerWidthMm * sourcePerMm * p.scale) / 2,
          centre.y + dy + (sy * p.outerHeightMm * sourcePerMm * p.scale) / 2,
        ),
      );
    };
    return {
      frame: corners(0, 0),
      cast: corners(p.profileDepthMm + lighting.shadowGapMm, 1.15),
      contact: corners(Math.max(2, lighting.shadowGapMm), 0.18),
    };
  }, [
    p.projectedCorners,
    p.calibration,
    p.outerWidthMm,
    p.outerHeightMm,
    p.profileDepthMm,
    p.positionX,
    p.positionY,
    p.scale,
    lighting.azimuth,
    lighting.elevation,
    lighting.shadowGapMm,
  ]);
  if (!geometry) return null;
  const alignment =
      p.projectedCorners?.length === 4
        ? "none"
        : p.room.imageAnchorX === "left"
          ? "xMinYMid slice"
          : "xMidYMid slice",
    opacity = Math.min(0.7, lighting.shadowOpacity * p.strength);
  return (
    <>
      <svg
        className="wall-shadow-overlay"
        viewBox="0 0 1 1"
        preserveAspectRatio={alignment}
        aria-hidden="true"
      >
        <defs>
          <filter
            id="wall-cast-blur"
            x="-40%"
            y="-40%"
            width="180%"
            height="180%"
          >
            <feGaussianBlur
              stdDeviation={0.0025 + lighting.shadowSoftness * 0.0007}
            />
          </filter>
          <filter
            id="wall-contact-blur"
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
          >
            <feGaussianBlur stdDeviation=".0015" />
          </filter>
        </defs>
        <polygon
          points={serialise(geometry.cast)}
          fill="#241f1b"
          opacity={opacity * 0.72}
          filter="url(#wall-cast-blur)"
        />
        <polygon
          points={serialise(geometry.contact)}
          fill="#191714"
          opacity={opacity * 0.62}
          filter="url(#wall-contact-blur)"
        />
      </svg>
      {lighting.goboEnabled && (
        <svg
          className="wall-gobo-overlay"
          viewBox="0 0 1 1"
          preserveAspectRatio={alignment}
          aria-hidden="true"
        >
          <defs>
            <clipPath id="wall-gobo-frame">
              <polygon points={serialise(geometry.frame)} />
            </clipPath>
            <linearGradient
              id="wall-gobo-pattern"
              x1="0"
              y1="0"
              x2="1"
              y2="0"
              gradientUnits="objectBoundingBox"
              gradientTransform={`rotate(${lighting.goboAngle} .5 .5)`}
            >
              <stop offset="0" stopColor="#000" />
              <stop offset={goboBand.start} stopColor="#000" />
              <stop
                offset={goboBand.startSoft}
                stopColor={temperatureCss(lighting.temperature)}
                stopOpacity=".78"
              />
              <stop
                offset={goboBand.endSoft}
                stopColor={temperatureCss(lighting.temperature)}
                stopOpacity=".78"
              />
              <stop offset={goboBand.end} stopColor="#000" />
              <stop offset="1" stopColor="#000" />
            </linearGradient>
            <filter
              id="wall-gobo-blur"
              x="-20%"
              y="-20%"
              width="140%"
              height="140%"
            >
              <feGaussianBlur
                stdDeviation={0.0008 + lighting.goboSoftness * 0.0005}
              />
            </filter>
          </defs>
          <rect
            width="1"
            height="1"
            fill="url(#wall-gobo-pattern)"
            opacity={goboOpacity}
            clipPath="url(#wall-gobo-frame)"
            filter="url(#wall-gobo-blur)"
            style={{ mixBlendMode: "screen" }}
          />
        </svg>
      )}
    </>
  );
}
