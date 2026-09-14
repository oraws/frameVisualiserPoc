import FramedArtwork from "../renderer/FramedArtwork";
import { mouldings } from "../mouldings/catalog";

export type PreviewReviewResult = {
  inputVariant?: string;
  outputVariant: string;
  revision: number;
  profile?: { points?: Array<[number, number]> };
};

export function MiniFramePreview({ sku, result, mode }: {
  sku: string;
  result?: PreviewReviewResult | null;
  mode: "before" | "after";
}) {
  const moulding = mouldings.find(item => item.sku === sku);
  if (!moulding) return <div className="batch-preview-empty">Moulding data unavailable</div>;
  const variant = mode === "after" && result
    ? result.outputVariant
    : result?.inputVariant || "supplier-derived-v2";
  return <FramedArtwork
    moulding={moulding} artWidth={700} artHeight={500} mount={50}
    mountColor="#e9e2d3" innerMount={0} innerMountColor="#1e201f"
    glass="None" lighting="Studio Soft" lightStrength={1} ambientFill={1}
    exposure={1} wallColour="#a7aaa8" view="Slight Angle" debug={false}
    artwork="/assets/artwork/img1.jpg" artworkColourMode="Source colours"
    geometryMode="Profile" materialMode="Texture" displayMode="Inspect"
    wallPreset="Studio" wallPositionX={0} wallPositionY={0} wallScale={1}
    wallShadow={1} roomMatchStrength={0} materialVariant={variant}
    materialRevision={result?.revision || 0}
    reviewProfile={mode === "after" ? result?.profile?.points : undefined}
    profileVariant="Current"
  />;
}
