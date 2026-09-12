#!/usr/bin/env python3
"""Extract assembled-frame catalogue photographs and build the family map.

These references describe the intended appearance of a family in use. They are
deliberately kept separate from exact-SKU photographs so neither the UI nor the
vision pipeline can mistake a family photograph for authoritative SKU colour or
cross-section geometry.
"""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path

from PIL import Image
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / "source-material/mainline/ml_catalogue.pdf"
PUBLIC = ROOT / "public/assets/moulding-families"
MANIFEST = ROOT / "src/mouldings/familyReferences.json"


MAINLINE_FAMILIES = [
    {"id": "fletcher-wood", "label": "Fletcher Wood", "skus": ["010-1009"], "images": [(29, 0)]},
    {"id": "l-shapes", "label": "L Shapes", "skus": ["POL-7145", "POL-7146"], "images": [(82, 0)]},
    {"id": "watercolour", "label": "Watercolour", "skus": ["POL-4540", "POL-4541"], "images": [(84, 0)]},
    {"id": "outline", "label": "Outline", "skus": ["POL-4417", "POL-4446"], "images": [(86, 4)]},
    {"id": "flats", "label": "Flats", "skus": ["POL-4721", "POL-4100", "POL-4202", "POL-4211", "POL-4415", "POL-4416", "POL-4418", "POL-4571"], "images": [(87, 0)]},
    {"id": "paramount", "label": "Paramount", "skus": ["POL-4506", "POL-4508"], "images": [(92, 0), (93, 0), (93, 1)]},
    {"id": "box", "label": "Box", "skus": ["POL-4344"], "images": [(94, 0)]},
    {"id": "edge", "label": "Edge", "skus": ["POL-1129", "POL-4313", "POL-4436"], "images": [(96, 7)]},
    {"id": "verona", "label": "Verona", "skus": ["POL-4875"], "images": [(106, 0)]},
    {"id": "hockney", "label": "Hockney", "skus": ["POL-7149", "POL-7150"], "images": [(112, 7)]},
    {"id": "contemporary-classics", "label": "Contemporary Classics", "skus": ["POL-2104", "POL-2109", "POL-2190"], "images": [(123, 0), (123, 4)]},
    {"id": "fletcher-polcore", "label": "Fletcher Polcore Basics", "skus": ["POL-7026"], "images": [(132, 0)]},
    {"id": "basic-flats", "label": "Basics Flats", "skus": ["POL-1009"], "images": [(139, 0)]},
    {"id": "nelson", "label": "Nelson", "skus": ["POL-1334", "POL-1336"], "images": [(144, 0)]},
    {"id": "naples", "label": "Naples", "skus": ["POL-4640", "POL-4642", "POL-4643"], "images": [(145, 0)]},
    {"id": "starling", "label": "Starling", "skus": ["POL-1301"], "images": [(146, 0)]},
]


CENTRADO_FAMILIES = [
    {"id": "alberta", "label": "Alberta", "skus": ["2650BK", "2650WH"], "sources": ["2650WH"]},
    {"id": "kashmir", "label": "Kashmir", "skus": ["3825BK", "3826BK"], "sources": ["3825BK", "3826BK"]},
    {"id": "bergen", "label": "Bergen", "skus": ["4924BG", "4925BG"], "sources": ["4924BG", "4925BG"]},
    {"id": "wentworth", "label": "Wentworth", "skus": ["8054BG"], "sources": ["8054BG"]},
    {"id": "create-3330", "label": "Create 33 × 30", "skus": ["CR3330AG"], "sources": ["CR3330AG"]},
]


def save_rgb(image: Image.Image, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(target, quality=94, subsampling=0)


def main() -> None:
    reader = PdfReader(str(PDF))
    families: list[dict] = []
    by_sku: dict[str, list[dict]] = {}

    for spec in MAINLINE_FAMILIES:
        references = []
        for ordinal, (page_number, image_index) in enumerate(spec["images"], 1):
            embedded = reader.pages[page_number - 1].images[image_index]
            image = Image.open(io.BytesIO(embedded.data))
            filename = f"catalogue-p{page_number:03d}-{ordinal}.jpg"
            target = PUBLIC / "mainline" / spec["id"] / filename
            save_rgb(image, target)
            references.append({
                "label": f"Family reference · {spec['label']}",
                "url": f"/assets/moulding-families/mainline/{spec['id']}/{filename}",
                "kind": "family",
                "family": spec["label"],
                "supplier": "Mainline",
                "sourceDocument": "source-material/mainline/ml_catalogue.pdf",
                "sourcePage": page_number,
                "evidenceUse": "assembly-and-family-appearance",
            })
        family = {**spec, "supplier": "Mainline", "references": references}
        family.pop("images", None)
        families.append(family)
        for sku in spec["skus"]:
            by_sku.setdefault(sku, []).extend(references)

    for spec in CENTRADO_FAMILIES:
        references = []
        for source_sku in spec["sources"]:
            source = ROOT / "source-material/centrado" / source_sku / "framed-reference.jpg"
            if not source.exists():
                continue
            filename = f"{source_sku}-framed-reference.jpg"
            target = PUBLIC / "centrado" / spec["id"] / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            references.append({
                "label": f"Family reference · {spec['label']}",
                "url": f"/assets/moulding-families/centrado/{spec['id']}/{filename}",
                "kind": "family",
                "family": spec["label"],
                "supplier": "Centrado",
                "sourceSku": source_sku,
                "evidenceUse": "assembly-and-family-appearance",
            })
        family = {**spec, "supplier": "Centrado", "references": references}
        family.pop("sources", None)
        families.append(family)
        for sku in spec["skus"]:
            by_sku.setdefault(sku, []).extend(references)

    payload = {
        "schemaVersion": 1,
        "guidance": "Family references show intended assembled appearance. Exact SKU photographs and physical sections remain authoritative for colour, finish and geometry.",
        "families": families,
        "bySku": by_sku,
    }
    MANIFEST.write_text(json.dumps(payload, indent=2) + "\n")
    (PUBLIC / "manifest.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Extracted {sum(len(f['references']) for f in families)} references for {len(by_sku)} mouldings")


if __name__ == "__main__":
    main()
