import { useEffect, useMemo, useState } from "react";
import FramedArtwork from "../renderer/FramedArtwork";
import WallShadowOverlay from "../renderer/WallShadowOverlay";
import {
  mouldings,
  mouldingSupplierCode,
  type Moulding,
} from "../mouldings/catalog";
import {
  mainlineCatalogueProfile,
  veronaProfile,
  veronaSamProfile,
} from "../mouldings/profiles";
import {
  roomPresetNames,
  roomPresets,
  type RoomTemplate,
} from "../renderer/roomTemplates";
import {
  roomAdminRooms,
  roomCalibrationKey,
  roomPreviewKey,
  roomVisibilityKey,
} from "../renderer/roomAdminRegistry";
import {
  customRoomImageUrl,
  listCustomRooms,
} from "../renderer/customRoomStore";

const mountColours = {
  "Off White": "#e9e2d3",
  White: "#f4f2ea",
  Cream: "#dfd1b6",
  "Light Grey": "#b9bbb7",
  Black: "#1e201f",
};
const sampleArtwork = "/assets/artwork/img1.jpg";
const emptyArtwork = "/assets/artwork/default.svg";
const reviewableSkus = ["POL-4100", "POL-4508", "POL-4418", "POL-4211"];
type ProfileVariant = "Current" | "SAM 2.1" | "Catalogue";
type RoomCalibration = {
  preview?: boolean;
  visibleInVisualizer?: boolean;
  manualCalibration?: {
    quadNormalised: number[][];
    frameCentreNormalised?: number[];
    scaleReference?: { lengthMm: number; pointsNormalised: number[][] };
  };
  renderer?: {
    cameraFovDegrees?: number;
    wallYawDegrees?: number;
    wallPitchDegrees?: number;
    perspectiveMode?: string;
    lighting?: {
      azimuth: number;
      elevation: number;
      keyStrength: number;
      ambientStrength: number;
      temperature: number;
      shadowOpacity: number;
      shadowSoftness: number;
      shadowGapMm: number;
    };
  };
};
const wallColours = [
  { name: "White", value: "#f2f0e9" },
  { name: "Warm white", value: "#d8d0c1" },
  { name: "Light grey", value: "#a9aaa7" },
  { name: "Mid grey", value: "#656865" },
  { name: "Charcoal", value: "#292c2a" },
  { name: "Deep green", value: "#18372f" },
  { name: "Navy", value: "#253449" },
];
const colourFilters: {
  key: string;
  label: string;
  swatch: string;
  tags?: string[];
}[] = [
  {
    key: "all",
    label: "All",
    swatch: "linear-gradient(135deg,#171717 0 33%,#9b6d39 33% 66%,#d5ac4e 66%)",
  },
  { key: "black", label: "Black", swatch: "#171817" },
  {
    key: "brown",
    label: "Brown",
    swatch: "#6f4a31",
    tags: ["brown", "walnut"],
  },
  { key: "gold", label: "Gold", swatch: "#c59a3e" },
  { key: "silver", label: "Silver", swatch: "#bfc2c3" },
  { key: "bronze", label: "Bronze", swatch: "#806344" },
  { key: "white", label: "White", swatch: "#eeeae0" },
  { key: "cream", label: "Cream", swatch: "#d8cfb7", tags: ["cream", "ivory"] },
  { key: "grey", label: "Grey", swatch: "#777a78" },
  { key: "red", label: "Red", swatch: "#a7322e" },
  { key: "orange", label: "Orange", swatch: "#c16931" },
  { key: "yellow", label: "Yellow", swatch: "#d4ad38" },
  {
    key: "blue",
    label: "Blue",
    swatch: "#324b6b",
    tags: ["blue", "navy", "midnight"],
  },
  {
    key: "natural",
    label: "Natural",
    swatch: "#a98152",
    tags: ["oak", "pine"],
  },
];
const mouldingColourTags = (moulding: Moulding) =>
  moulding.colourTags ||
  colourFilters
    .slice(1)
    .filter((colour) =>
      new RegExp(`\\b${colour.key}\\b`, "i").test(
        `${moulding.name} ${moulding.finish}`,
      ),
    )
    .map((colour) => colour.key);
const matchesColour = (moulding: Moulding, colour: string) => {
  if (colour === "all") return true;
  const filter = colourFilters.find((item) => item.key === colour),
    tags = filter?.tags || [colour];
  return mouldingColourTags(moulding).some((tag) => tags.includes(tag));
};
export default function Visualiser() {
  const [sku, setSku] = useState("POL-4875"),
    [colourFilter, setColourFilter] = useState("all"),
    [artWidth, setArtWidth] = useState(700),
    [artHeight, setArtHeight] = useState(500),
    [mount, setMount] = useState(50),
    [mountName, setMountName] = useState("Off White"),
    [glass, setGlass] = useState("Standard"),
    [lighting, setLighting] = useState("Window Left"),
    [lightStrength, setLightStrength] = useState(1),
    [ambientFill, setAmbientFill] = useState(1),
    [exposure, setExposure] = useState(1),
    [wallColour, setWallColour] = useState("#a9aaa7"),
    [view, setView] = useState("Slight Angle"),
    [debug, setDebug] = useState(false),
    [artwork, setArtwork] = useState(sampleArtwork),
    [geometryMode, setGeometryMode] = useState<"Profile" | "Flat Legacy">(
      "Profile",
    ),
    [materialMode, setMaterialMode] = useState<
      "Texture" | "Clay" | "Normal" | "Wireframe"
    >("Texture"),
    [displayMode, setDisplayMode] = useState<"Inspect" | "Wall" | "Review">(
      "Inspect",
    ),
    [wallPreset, setWallPreset] = useState("Oblique Gallery Wall"),
    [wallPositionX, setWallPositionX] = useState(0),
    [wallPositionY, setWallPositionY] = useState(0),
    [wallScale, setWallScale] = useState(1),
    [wallShadow, setWallShadow] = useState(1),
    [supplierFrame, setSupplierFrame] = useState(0),
    [reviewDecision, setReviewDecision] = useState("Pending review"),
    [materialVariant, setMaterialVariant] = useState<
      "baseline-v1" | "multiframe-experiment-v1"
    >("baseline-v1"),
    [profileVariant, setProfileVariant] = useState<ProfileVariant>("Current");
  const [roomCalibrations, setRoomCalibrations] = useState<
    Record<string, RoomCalibration>
  >({});
  const [roomVisibility, setRoomVisibility] = useState<Record<string, boolean>>(
    {},
  );
  const [wallProjection, setWallProjection] = useState<number[][] | null>(null);
  const [customRoomTemplates, setCustomRoomTemplates] = useState<
    Record<string, RoomTemplate>
  >({});
  const moulding = useMemo(() => mouldings.find((x) => x.sku === sku)!, [sku]),
    filteredMouldings = useMemo(
      () => mouldings.filter((item) => matchesColour(item, colourFilter)),
      [colourFilter],
    );
  const hasCatalogueProfile = !!mainlineCatalogueProfile(sku),
    alternate4508 = sku === "POL-4508" && profileVariant !== "Current",
    visibleFace =
      moulding.widthMm +
      (alternate4508
        ? 0
        : moulding.supplier === "Centrado"
          ? 0
          : moulding.accentWidthMm || 0),
    outerW = artWidth + 2 * (mount + visibleFace),
    outerH = artHeight + 2 * (mount + visibleFace);
  useEffect(() => {
    setReviewDecision(
      localStorage.getItem(`moulding-review:${sku}:${materialVariant}`) ||
        "Pending review",
    );
  }, [sku, materialVariant]);
  useEffect(() => {
    setMaterialVariant(
      sku === "POL-4100"
        ? "baseline-v1"
        : reviewableSkus.includes(sku)
          ? "multiframe-experiment-v1"
          : "baseline-v1",
    );
  }, [sku]);
  useEffect(() => {
    if (!hasCatalogueProfile) setProfileVariant("Current");
    else if (
      profileVariant === "SAM 2.1" &&
      !["POL-4508", "POL-4875"].includes(sku)
    )
      setProfileVariant("Current");
  }, [sku, hasCatalogueProfile]);
  useEffect(() => {
    setWallPositionX(0);
    setWallPositionY(0);
    setWallScale(1);
    setWallShadow(1);
    setWallProjection(null);
  }, [wallPreset]);
  useEffect(() => {
    const approved: Record<string, RoomCalibration> = {},
      visibility: Record<string, boolean> = {};
    const params = new URLSearchParams(window.location.search),
      previewRequested = params.get("preview") === "1",
      requestedId = params.get("room");
    roomAdminRooms.forEach((room) => {
      visibility[room.id] =
        localStorage.getItem(roomVisibilityKey(room.id)) !== "false";
      try {
        const calibration = JSON.parse(
          localStorage.getItem(roomCalibrationKey(room.id)) || "null",
        );
        if (calibration?.approved === true) approved[room.id] = calibration;
      } catch {
        /* ignore invalid local admin state */
      }
    });
    if (previewRequested && requestedId)
      try {
        const preview = JSON.parse(
          localStorage.getItem(roomPreviewKey(requestedId)) || "null",
        );
        if (preview?.preview) approved[requestedId] = preview;
      } catch {
        /* ignore invalid preview state */
      }
    setRoomCalibrations(approved);
    setRoomVisibility(visibility);
    if (params.get("mode") === "wall") setDisplayMode("Wall");
    const requestedRoom = roomAdminRooms.find(
      (room) => room.id === params.get("room"),
    );
    if (
      requestedRoom &&
      approved[requestedRoom.id] &&
      (previewRequested ||
        (visibility[requestedRoom.id] !== false &&
          approved[requestedRoom.id]?.visibleInVisualizer !== false))
    )
      setWallPreset(requestedRoom.name);
    listCustomRooms()
      .then((rooms) => {
        const templates: Record<string, RoomTemplate> = {},
          customApproved: Record<string, RoomCalibration> = {};
        const customVisibility: Record<string, boolean> = {};
        rooms.forEach((room) => {
          customVisibility[room.id] =
            localStorage.getItem(roomVisibilityKey(room.id)) !== "false";
          templates[room.name] = {
            calibrationId: room.id,
            image: customRoomImageUrl(room),
            imageAspect: room.width / room.height,
            imageAnchorX: "center",
            framePosition: [0, 0, 0],
            frameScale: 1,
            frameRotation: [0, 0, 0],
            camera: { position: [0, 0.1, 9.2], fov: 36 },
            keyLight: {
              position: [-4, 4, 5],
              intensity: 1.7,
              color: "#f4eadb",
            },
            ambient: 0.76,
            environment: 0.44,
            shadow: {
              opacity: 0.2,
              color: "#51483f",
              bias: -0.00018,
              radius: 12,
            },
            tintOpacity: 0.02,
            angleLabel: "Admin-calibrated upload",
            calibrationStatus: "approved-local",
          };
          try {
            const calibration = JSON.parse(
              localStorage.getItem(roomCalibrationKey(room.id)) || "null",
            );
            if (calibration?.approved) customApproved[room.id] = calibration;
            if (previewRequested && requestedId === room.id) {
              const preview = JSON.parse(
                localStorage.getItem(roomPreviewKey(room.id)) || "null",
              );
              if (preview?.preview) customApproved[room.id] = preview;
            }
          } catch {
            /* invalid local state */
          }
        });
        setCustomRoomTemplates(templates);
        setRoomCalibrations((current) => ({ ...current, ...customApproved }));
        setRoomVisibility((current) => ({ ...current, ...customVisibility }));
        const requested = rooms.find((room) => room.id === requestedId);
        if (
          requested &&
          customApproved[requested.id] &&
          (previewRequested ||
            customApproved[requested.id]?.visibleInVisualizer !== false)
        )
          setWallPreset(requested.name);
      })
      .catch(() => {
        /* IndexedDB unavailable */
      });
  }, []);
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setArtwork(URL.createObjectURL(f));
  };
  const saveDecision = (decision: string) => {
    setReviewDecision(decision);
    localStorage.setItem(`moulding-review:${sku}:${materialVariant}`, decision);
  };
  const chooseColour = (colour: string) => {
    setColourFilter(colour);
    const choices = mouldings.filter((item) => matchesColour(item, colour));
    if (!choices.some((item) => item.sku === sku) && choices[0]) {
      setSku(choices[0].sku);
      setSupplierFrame(0);
    }
  };
  const variantRoot = `/assets/mouldings/${sku}/variants/${materialVariant}`;
  const allRoomTemplates = { ...roomPresets, ...customRoomTemplates };
  const availableRoomNames = [
    ...roomPresetNames,
    ...Object.keys(customRoomTemplates),
  ].filter((name) => {
    const room = allRoomTemplates[name],
      id = room.calibrationId,
      calibration = id ? roomCalibrations[id] : null;
    if (!id) return true;
    if (roomVisibility[id] === false) return false;
    if (calibration) return calibration.visibleInVisualizer !== false;
    return room.calibrationStatus !== "approved-local";
  });
  const activeRoom = allRoomTemplates[wallPreset];
  const activeCalibration = activeRoom?.calibrationId
    ? roomCalibrations[activeRoom.calibrationId] || null
    : null;
  const roomStatus = activeCalibration?.preview
    ? "Admin lighting preview"
    : activeCalibration
      ? "Admin approved"
      : activeRoom?.calibrationStatus === "unverified"
        ? "Unverified estimate"
        : "Legacy placement";
  const roomPerspective =
    activeCalibration?.renderer?.perspectiveMode === "calibrated-quad"
      ? "Calibrated quad"
      : activeRoom?.angleLabel;
  return (
    <main className="app">
      <section
        className={`stage ${displayMode === "Wall" ? "wall-stage" : ""} ${["#f2f0e9", "#d8d0c1", "#a9aaa7"].includes(wallColour) && displayMode !== "Wall" ? "light-stage" : ""}`}
      >
        <div className="brand">
          atelier / frame study<span>supplier-grounded visualisation POC</span>
        </div>
        {displayMode === "Wall" && activeRoom && (
          <>
            <img
              className="wall-photo"
              src={activeRoom.image}
              style={{
                objectPosition:
                  activeRoom.imageAnchorX === "left" ? "left center" : "center",
              }}
              alt=""
            />
            <WallShadowOverlay
              room={activeRoom}
              calibration={activeCalibration}
              outerWidthMm={outerW}
              outerHeightMm={outerH}
              profileDepthMm={moulding.depthMm}
              positionX={wallPositionX}
              positionY={wallPositionY}
              scale={wallScale}
              strength={wallShadow}
              projectedCorners={wallProjection}
            />
          </>
        )}
        <FramedArtwork
          moulding={moulding}
          artWidth={artWidth}
          artHeight={artHeight}
          mount={mount}
          mountColor={mountColours[mountName as keyof typeof mountColours]}
          glass={glass}
          lighting={lighting}
          lightStrength={lightStrength}
          ambientFill={ambientFill}
          exposure={exposure}
          wallColour={wallColour}
          view={displayMode === "Review" ? "Review" : view}
          debug={debug}
          artwork={artwork}
          geometryMode={geometryMode}
          materialMode={materialMode}
          displayMode={displayMode === "Wall" ? "Wall" : "Inspect"}
          wallPreset={wallPreset}
          wallPositionX={wallPositionX}
          wallPositionY={wallPositionY}
          wallScale={wallScale}
          wallShadow={wallShadow}
          materialVariant={materialVariant}
          profileVariant={profileVariant}
          roomCalibration={activeCalibration}
          roomTemplate={activeRoom}
          overlayOnly={displayMode === "Wall"}
          onWallProjection={setWallProjection}
        />
        <div className="status">
          {displayMode === "Wall"
            ? `Photographic room · ${roomStatus}`
            : displayMode === "Review"
              ? "Approval view · right-drag to move"
              : "Drag to orbit · right-drag to move · scroll to zoom"}
        </div>
      </section>
      <aside className="panel">
        <h1>Frame Visualiser</h1>
        <p className="subtitle">
          A supplier-grounded material, proportion and room study.
        </p>
        <nav className="app-nav">
          <span>Viewer</span>
          <a href="/room-calibrator/">Room admin</a>
        </nav>
        <div className="group">
          <label>Presentation</label>
          <div className="chips mode-chips">
            {(["Inspect", "Wall", "Review"] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  setDisplayMode(v);
                  if (v === "Review") {
                    if (!reviewableSkus.includes(sku)) setSku("POL-4100");
                    setSupplierFrame(2);
                    setMaterialMode("Texture");
                  }
                }}
                className={displayMode === v ? "active" : ""}
              >
                {v === "Inspect"
                  ? "Frame detail"
                  : v === "Wall"
                    ? "View on wall"
                    : "Asset review"}
              </button>
            ))}
          </div>
          {displayMode === "Wall" && (
            <>
              <label style={{ marginTop: 14 }}>Photographic room</label>
              <select
                value={wallPreset}
                onChange={(e) => setWallPreset(e.target.value)}
              >
                {availableRoomNames.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              <div
                className={`room-calibration ${activeRoom?.calibrationStatus === "unverified" ? "unverified" : activeRoom?.calibrationStatus === "approved-local" ? "approved" : ""}`}
              >
                <span>{roomStatus}</span>
                <b>{roomPerspective}</b>
              </div>
              <a
                className="room-calibrator-link"
                href={`/room-calibrator/?room=${activeRoom?.calibrationId || "stock-pilot"}`}
              >
                Manage room calibration →
              </a>
              <label style={{ marginTop: 14 }}>Frame placement</label>
              <RangeControl
                label="Horizontal"
                value={wallPositionX}
                min={-1}
                max={1}
                step={0.02}
                display={`${wallPositionX > 0 ? "+" : ""}${Math.round(wallPositionX * 100)}`}
                onChange={setWallPositionX}
              />
              <RangeControl
                label="Vertical"
                value={wallPositionY}
                min={-1}
                max={1}
                step={0.02}
                display={`${wallPositionY > 0 ? "+" : ""}${Math.round(wallPositionY * 100)}`}
                onChange={setWallPositionY}
              />
              <RangeControl
                label="Scale"
                value={wallScale}
                min={0.55}
                max={1.5}
                step={0.01}
                display={`${Math.round(wallScale * 100)}%`}
                onChange={setWallScale}
              />
              <RangeControl
                label="Wall shadow"
                value={wallShadow}
                min={0}
                max={1.6}
                step={0.05}
                display={`${Math.round(wallShadow * 100)}%`}
                onChange={setWallShadow}
              />
              <button
                className="placement-reset"
                type="button"
                onClick={() => {
                  setWallPositionX(0);
                  setWallPositionY(0);
                  setWallScale(1);
                  setWallShadow(1);
                }}
              >
                Reset room placement
              </button>
            </>
          )}
        </div>
        <div className="group">
          <label>Filter by colour</label>
          <div className="colour-filters">
            {colourFilters.map((colour) => (
              <button
                key={colour.key}
                type="button"
                className={colourFilter === colour.key ? "active" : ""}
                onClick={() => chooseColour(colour.key)}
                aria-pressed={colourFilter === colour.key}
                title={colour.label}
              >
                <i style={{ background: colour.swatch }} />
                <span>{colour.label}</span>
              </button>
            ))}
          </div>
          <label style={{ marginTop: 14 }}>Moulding</label>
          <select
            value={sku}
            onChange={(e) => {
              setSku(e.target.value);
              setSupplierFrame(0);
            }}
          >
            {filteredMouldings.map((m) => (
              <option key={`${m.supplier}-${m.sku}`} value={m.sku}>
                {mouldingSupplierCode(m)} · {m.sku} · {m.name} — {m.widthMm} mm
                {m.discontinued ? " · discontinued" : ""}
              </option>
            ))}
          </select>
          {moulding.description && (
            <p className="catalog-description">{moulding.description}</p>
          )}
          <div className="dimension">
            SUPPLIER <b>{mouldingSupplierCode(moulding)}</b>
            <br />
            FACE WIDTH <b>{moulding.widthMm} mm</b>
            {moulding.accentWidthMm &&
              !alternate4508 &&
              moulding.supplier !== "Centrado" && (
                <>
                  <br />
                  SIGHT EDGE <b>+ {moulding.accentWidthMm} mm</b>
                </>
              )}
            {moulding.accentWidthMm && moulding.supplier === "Centrado" && (
              <>
                <br />
                ACCENT REGION <b>{moulding.accentWidthMm} mm</b>
              </>
            )}
            {alternate4508 && (
              <>
                <br />
                SILVER BAND <b>0–9.5 mm</b>
              </>
            )}
            <br />
            PROFILE DEPTH <b>{moulding.depthMm} mm</b>
            <br />
            RESPONSE <b>{moulding.finish}</b>
          </div>
          <div className="confidence">
            <span>{moulding.confidence.shape}</span>{" "}
            {moulding.renderStatus === "supplier-reference"
              ? "supplier reference only · profile queued"
              : "profile · supplier dimensions"}
            {moulding.discontinued && <em> · discontinued</em>}
          </div>
        </div>
        {hasCatalogueProfile && (
          <div className="group">
            <label>Profile comparison</label>
            <div className="chips">
              <button
                className={profileVariant === "Current" ? "active" : ""}
                onClick={() => setProfileVariant("Current")}
              >
                Current
              </button>
              {["POL-4508", "POL-4875"].includes(sku) && (
                <button
                  className={profileVariant === "SAM 2.1" ? "active" : ""}
                  onClick={() => setProfileVariant("SAM 2.1")}
                >
                  SAM 2.1
                </button>
              )}
              <button
                className={profileVariant === "Catalogue" ? "active" : ""}
                onClick={() => setProfileVariant("Catalogue")}
              >
                Catalogue
              </button>
            </div>
            <p className="review-note">
              {profileVariant === "Current"
                ? "Existing protected render"
                : profileVariant === "SAM 2.1"
                  ? "Experimental supplier-spin reconstruction · not approved"
                  : "Metric profile extracted from the catalogue cross-section · batch review candidate"}
            </p>
            {profileVariant === "Catalogue" && (
              <div className="catalogue-evidence">
                <img
                  src={`/assets/mouldings/${sku}/catalogue/source.png`}
                  alt={`${sku} catalogue cross-section`}
                />
                <img
                  src={`/assets/mouldings/${sku}/catalogue/profile-diagnostic.png`}
                  alt={`${sku} extracted profile diagnostic`}
                />
              </div>
            )}
          </div>
        )}
        {displayMode === "Review" && reviewableSkus.includes(sku) && (
          <div className="group review-card">
            <label>
              {sku === "POL-4100"
                ? "Material comparison"
                : "Experimental material"}
            </label>
            <div
              className={`variant-switch ${sku !== "POL-4100" ? "single" : ""}`}
            >
              {sku === "POL-4100" && (
                <button
                  className={materialVariant === "baseline-v1" ? "active" : ""}
                  onClick={() => setMaterialVariant("baseline-v1")}
                >
                  <strong>Protected baseline</strong>
                  <span>Single supplier image · tuned</span>
                </button>
              )}
              <button
                className={
                  materialVariant === "multiframe-experiment-v1"
                    ? "active experiment"
                    : ""
                }
                onClick={() => setMaterialVariant("multiframe-experiment-v1")}
              >
                <strong>Multi-frame</strong>
                <span>7 supplier spin frames</span>
              </button>
            </div>
            <div
              className={
                materialVariant === "baseline-v1"
                  ? "baseline-badge"
                  : "baseline-badge experiment"
              }
            >
              {materialVariant === "baseline-v1"
                ? "Protected baseline · v1"
                : "Inactive experiment · v1"}
            </div>
            {materialVariant === "multiframe-experiment-v1" && (
              <img
                className="variant-source-strip"
                src={`${variantRoot}/source-frames.jpg`}
                alt={`Seven ${sku} supplier spin frames fused for the experimental material`}
              />
            )}
            <label>{sku} approval evidence</label>
            <div className="review-profile">
              <img
                src={
                  sku === "POL-4100"
                    ? "/assets/mouldings/POL-4100/profile-overlay.png"
                    : moulding.supplierImages?.[2]?.url
                }
                alt={`${moulding.name} supplier profile evidence`}
              />
              <div>
                <strong>Profile candidate</strong>
                <span>
                  {sku === "POL-4508" ? "13 silver + 2 black" : "4"} calibrated
                  points
                </span>
                <span>
                  {sku === "POL-4508"
                    ? `${moulding.widthMm} + ${moulding.accentWidthMm} × ${moulding.depthMm}`
                    : `${moulding.widthMm} × ${moulding.depthMm}`}{" "}
                  mm envelope
                </span>
                <span>
                  {sku === "POL-4100"
                    ? "Shared by both variants"
                    : sku === "POL-4508"
                      ? "Photo-calibrated joined sections"
                      : "Rebate exact · transition approximate"}
                </span>
                <ProfileMiniPlot
                  sku={sku}
                  width={moulding.widthMm}
                  depth={moulding.depthMm}
                />
              </div>
            </div>
            <label>Supplier-derived material maps</label>
            <div className="review-maps">
              {[
                ["basecolor.jpg", "Colour"],
                ["roughness.jpg", "Roughness"],
                ["bump.jpg", "Micro relief"],
              ].map(([file, label]) => (
                <figure key={file}>
                  <img
                    src={`${variantRoot}/${file}`}
                    alt={`${label} material map`}
                  />
                  <figcaption>{label}</figcaption>
                </figure>
              ))}
            </div>
            <div
              className={`review-state ${reviewDecision === "Approved" ? "approved" : reviewDecision === "Fine tuning requested" ? "tuning" : ""}`}
            >
              {reviewDecision}
            </div>
            <div className="review-actions">
              <button
                className="approve"
                onClick={() => saveDecision("Approved")}
              >
                Approve this variant
              </button>
              <button onClick={() => saveDecision("Fine tuning requested")}>
                Send to fine tuning
              </button>
            </div>
            <p className="review-note">
              The live frame at left uses this variant. Review decisions are
              stored per SKU and variant. POL-4100’s protected baseline remains
              unchanged.
            </p>
          </div>
        )}
        {!!moulding.supplierImages?.length && (
          <div className="group supplier-reference">
            <label>Supplier references</label>
            <div className="supplier-hero">
              <img
                src={moulding.supplierImages[supplierFrame]?.url}
                alt={`${moulding.name} ${moulding.supplierImages[supplierFrame]?.label}`}
              />
              <span>{moulding.supplierImages[supplierFrame]?.label}</span>
            </div>
            <div className="supplier-thumbs">
              {moulding.supplierImages.map((image, index) => (
                <button
                  key={image.url}
                  className={supplierFrame === index ? "selected" : ""}
                  onClick={() => setSupplierFrame(index)}
                  title={image.label}
                >
                  <img src={image.url} alt={image.label} />
                  <small>{String(index + 1).padStart(2, "0")}</small>
                </button>
              ))}
            </div>
            {moulding.sourceUrl && (
              <a
                className="source-link"
                href={moulding.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open supplier product page ↗
              </a>
            )}
          </div>
        )}
        <div className="group">
          <label>Artwork dimensions (mm)</label>
          <div className="row">
            <input
              aria-label="Artwork width"
              type="number"
              value={artWidth}
              onChange={(e) => setArtWidth(+e.target.value)}
            />
            <input
              aria-label="Artwork height"
              type="number"
              value={artHeight}
              onChange={(e) => setArtHeight(+e.target.value)}
            />
          </div>
          <label style={{ marginTop: 12 }}>Replace artwork</label>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={upload}
          />
          <div className="artwork-actions">
            <button
              type="button"
              className={artwork === sampleArtwork ? "active" : ""}
              onClick={() => setArtwork(sampleArtwork)}
            >
              Use sample artwork
            </button>
            <button
              type="button"
              className={artwork === emptyArtwork ? "active" : ""}
              onClick={() => setArtwork(emptyArtwork)}
            >
              Clear artwork
            </button>
          </div>
        </div>
        <div className="group">
          <label>Mount</label>
          <select
            value={mountName}
            onChange={(e) => setMountName(e.target.value)}
          >
            {Object.keys(mountColours).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <div className="chips" style={{ marginTop: 9 }}>
            {[0, 30, 50, 70].map((v) => (
              <button
                key={v}
                onClick={() => setMount(v)}
                className={mount === v ? "active" : ""}
              >
                {v === 0 ? "No mount" : `${v} mm`}
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          <label>Glazing</label>
          <div className="chips">
            {["None", "Standard", "Museum"].map((v) => (
              <button
                key={v}
                onClick={() => setGlass(v)}
                className={glass === v ? "active" : ""}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          <label>Wall colour</label>
          <div className="wall-colours">
            {wallColours.map((colour) => (
              <button
                key={colour.name}
                type="button"
                className={wallColour === colour.value ? "active" : ""}
                onClick={() => setWallColour(colour.value)}
                title={colour.name}
                aria-label={`Wall colour ${colour.name}`}
              >
                <i style={{ background: colour.value }} />
                <span>{colour.name}</span>
              </button>
            ))}
          </div>
          {displayMode === "Wall" && (
            <p className="review-note">
              A restrained photographic tint preview; the room’s original
              material detail and light remain visible.
            </p>
          )}
        </div>
        <div className="group lighting-controls">
          <label>
            {displayMode === "Wall" ? "Room-matched lighting" : "Lighting"}
          </label>
          {displayMode !== "Wall" && (
            <select
              value={lighting}
              onChange={(e) => setLighting(e.target.value)}
            >
              {[
                "Studio Soft",
                "Window Left",
                "Warm Interior",
                "Dramatic Raking Light",
              ].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
          {displayMode === "Wall" && (
            <p className="room-light-note">
              The approved Room Admin direction, warmth and softness now drive
              the real 3D frame lights and wall shadow.
            </p>
          )}
          <RangeControl
            label="Key light"
            value={lightStrength}
            min={0.35}
            max={2.2}
            step={0.05}
            display={`${Math.round(lightStrength * 100)}%`}
            onChange={setLightStrength}
          />
          <RangeControl
            label="Shadow fill"
            value={ambientFill}
            min={0.35}
            max={2.2}
            step={0.05}
            display={`${Math.round(ambientFill * 100)}%`}
            onChange={setAmbientFill}
          />
          <RangeControl
            label="Exposure"
            value={exposure}
            min={0.65}
            max={1.65}
            step={0.05}
            display={`${exposure.toFixed(2)}×`}
            onChange={setExposure}
          />
          <button
            className="lighting-reset"
            type="button"
            onClick={() => {
              setLightStrength(1);
              setAmbientFill(1);
              setExposure(1);
            }}
          >
            Reset light adjustments
          </button>
        </div>
        {displayMode === "Inspect" && (
          <div className="group">
            <label>View</label>
            <div className="chips">
              {["Front", "Slight Angle", "Detail"].map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={view === v ? "active" : ""}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="group">
          <label>Geometry</label>
          <div className="chips">
            {(["Profile", "Flat Legacy"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setGeometryMode(v)}
                className={geometryMode === v ? "active" : ""}
              >
                {v}
              </button>
            ))}
          </div>
          <label style={{ marginTop: 14 }}>Material diagnostic</label>
          <div className="chips">
            {(["Texture", "Clay", "Normal", "Wireframe"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setMaterialMode(v)}
                className={materialMode === v ? "active" : ""}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          <div className="dimension">
            OUTER FRAME{" "}
            <b>
              {Math.round(outerW)} × {Math.round(outerH)} mm
            </b>
            <br />
            MOUNT OPENING{" "}
            <b>
              {artWidth} × {artHeight} mm
            </b>
          </div>
          <button
            onClick={() => setDebug(!debug)}
            className={debug ? "active" : ""}
          >
            {debug ? "Hide diagnostic" : "Show diagnostic"}
          </button>
          {debug && (
            <div className="debug" style={{ marginTop: 10 }}>
              SKU: {moulding.sku}
              <br />
              PROFILE: {moulding.profileType}
              <br />
              SOURCE: {profileVariant}
              <br />
              ROUGHNESS: {moulding.roughness}
              <br />
              SHAPE: {moulding.confidence.shape}
              <br />
              TEXTURE: {moulding.confidence.texture}
            </div>
          )}
          {debug && moulding.sku === "POL-4875" && (
            <ProfilePlot variant={profileVariant} />
          )}
        </div>
      </aside>
    </main>
  );
}
function ProfilePlot({ variant }: { variant: ProfileVariant }) {
  const points =
      variant === "Catalogue"
        ? mainlineCatalogueProfile("POL-4875") || veronaProfile
        : variant === "SAM 2.1"
          ? veronaSamProfile
          : veronaProfile,
    path = points
      .map(([u, z], i) => `${i ? "L" : "M"} ${12 + u * 2.55} ${142 - z * 2.45}`)
      .join(" ");
  return (
    <svg
      viewBox="0 0 280 165"
      style={{
        width: "100%",
        marginTop: 10,
        background: "#151615",
        border: "1px solid #ffffff13",
      }}
      aria-label={`${variant} Verona profile`}
    >
      <path d="M 12 142 H 268 M 12 142 V 14" stroke="#77756e" />
      <path d={path} fill="none" stroke="#d8b976" strokeWidth="2" />
      <text x="12" y="159" fill="#aaa89e" fontSize="10">
        0 mm
      </text>
      <text x="226" y="159" fill="#aaa89e" fontSize="10">
        97 mm
      </text>
      <text x="15" y="25" fill="#aaa89e" fontSize="10">
        49 mm
      </text>
    </svg>
  );
}
function RangeControl({
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
    <label className="range-control">
      <span>
        {label}
        <b>{display}</b>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
function ProfileMiniPlot({
  sku,
  width,
  depth,
}: {
  sku: string;
  width: number;
  depth: number;
}) {
  const totalWidth = sku === "POL-4508" ? 39.5 : width,
    points =
      sku === "POL-4508"
        ? [
            [0, 17],
            [0.5, 16],
            [1.2, 14],
            [2.2, 12.5],
            [3.3, 12],
            [4.3, 12.5],
            [5.3, 14],
            [6.4, 17],
            [7.4, 21],
            [8.3, 25.5],
            [9, 28.5],
            [9.5, 30],
            [39.5, 30],
          ]
        : sku === "POL-4100"
          ? [
              [0, 4],
              [4.871, 4],
              [7.307, 13],
              [41, 13],
            ]
          : [
              [0, 6],
              [4.5, 6],
              [6.5, 20],
              [54, 20],
            ];
  const x = (u: number) => 4 + (u / totalWidth) * 122,
    y = (z: number) => 44 - (z / depth) * 39,
    path = points
      .map(([u, z], i) => `${i ? "L" : "M"} ${x(u)} ${y(z)}`)
      .join(" ");
  return (
    <svg
      className="review-profile-plot"
      viewBox="0 0 130 52"
      aria-label={`${sku} profile`}
    >
      <path d="M 4 44 H 126 M 4 44 V 5" stroke="#77756e" strokeWidth="1" />
      <path d={path} fill="none" stroke="#d8b976" strokeWidth="2" />
      <path
        d={`M ${x(sku === "POL-4508" ? 9.5 : totalWidth)} 5 V 44`}
        stroke="#bfc2c1"
        strokeWidth="1"
        strokeDasharray="2 2"
      />
      <text x="4" y="51" fill="#88867e" fontSize="6">
        inner
      </text>
      <text x="100" y="51" fill="#88867e" fontSize="6">
        {totalWidth} mm
      </text>
    </svg>
  );
}
