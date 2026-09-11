export type WindowLightControls = {
  goboAngle: number;
  goboScale: number;
  goboOffsetX: number;
  goboOffsetY: number;
  goboSoftness: number;
};

export const MAX_WINDOW_LIGHT_STRENGTH = 0.1;

export function clampWindowLightStrength(value: number) {
  return Math.max(0, Math.min(MAX_WINDOW_LIGHT_STRENGTH, value));
}

export function windowLightBand(controls: WindowLightControls) {
  const radians = (controls.goboAngle * Math.PI) / 180;
  // Horizontal is deliberately screen-relative: moving its slider right must
  // move the visible light to the right regardless of the band's angle.
  // Vertical still nudges the band along its rotated normal, but cannot
  // overpower the horizontal control.
  const projectedOffset =
    controls.goboOffsetX + controls.goboOffsetY * Math.sin(radians) * 0.35;
  const centre = Math.max(
    0.02,
    Math.min(0.98, 0.5 + projectedOffset * 0.48),
  );
  const halfWidth = Math.max(
    0.12,
    Math.min(0.42, 0.2 * controls.goboScale),
  );
  const feather = Math.max(
    0.018,
    Math.min(0.11, 0.018 + controls.goboSoftness * 0.006),
  );
  return {
    start: Math.max(0, centre - halfWidth),
    startSoft: Math.max(0, centre - halfWidth + feather),
    endSoft: Math.min(1, centre + halfWidth - feather),
    end: Math.min(1, centre + halfWidth),
  };
}
