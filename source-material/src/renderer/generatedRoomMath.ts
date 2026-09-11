/** Match a fixed vertical-FOV camera to an object-fit photograph, without
 * rescaling the product. Both contain and cover retain the authored millimetres.
 */
export function fittedRoomFov(baseFov: number, imageAspect: number, viewportAspect: number, fit: 'contain' | 'cover') {
  const ratio = imageAspect / Math.max(.01, viewportAspect);
  const scale = fit === 'contain' ? Math.max(1, ratio) : Math.min(1, ratio);
  return 2 * Math.atan(Math.tan(baseFov * Math.PI / 360) * scale) * 180 / Math.PI;
}
