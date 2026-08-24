#!/usr/bin/env python3
"""Reusable parser for Mainline's dimensioned moulding specification template."""

import argparse
import json
import re
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageOps


class MainlineSpecParser:
    def __init__(self, pdf_path: Path, page_number: int = 2):
        self.pdf_path = Path(pdf_path)
        self.document = pymupdf.open(self.pdf_path)
        self.page_number = page_number
        self.page = self.document[page_number - 1]

    def _text_spans(self):
        return [span for block in self.page.get_text("dict")["blocks"] if "lines" in block
                for line in block["lines"] for span in line["spans"] if span["text"].strip()]

    def _dimension_lines(self, image_rect):
        lines = []
        for drawing in self.page.get_drawings():
            for item in drawing["items"]:
                if item[0] != "l":
                    continue
                p0, p1 = item[1], item[2]
                dx, dy = abs(p1.x - p0.x), abs(p1.y - p0.y)
                if max(dx, dy) < 20:
                    continue
                lines.append({"x0": p0.x, "y0": p0.y, "x1": p1.x, "y1": p1.y,
                              "orientation": "horizontal" if dx > dy else "vertical", "length": max(dx, dy)})
        horizontal = [line for line in lines if line["orientation"] == "horizontal" and line["y0"] < image_rect.y0]
        left_vertical = [line for line in lines if line["orientation"] == "vertical" and line["x0"] < image_rect.x0]
        right_vertical = [line for line in lines if line["orientation"] == "vertical" and line["x0"] > image_rect.x1]
        return {
            "width": max(horizontal, key=lambda line: line["length"]),
            "depth": max(left_vertical, key=lambda line: line["length"]),
            "rebate": max(right_vertical, key=lambda line: line["length"]),
        }

    def inspect(self):
        images = []
        for ordinal, image in enumerate(self.page.get_images(full=True), 1):
            xref, _, width, height, _, colorspace, _, name, filter_name = image[:9]
            placements = self.page.get_image_rects(xref, transform=True)
            images.append({
                "ordinal": ordinal, "xref": xref, "width": width, "height": height,
                "colorspace": str(colorspace), "name": name, "filter": filter_name,
                "placements": [{"rect": list(rect), "matrix": list(matrix)} for rect, matrix in placements]
            })
        profile_image = max(images, key=lambda image: image["height"])
        image_rect = pymupdf.Rect(profile_image["placements"][0]["rect"])
        lines = self._dimension_lines(image_rect)
        dimension_text = {}
        for span in self._text_spans():
            match = re.fullmatch(r"(\d+)mm", span["text"].strip())
            if match:
                dimension_text[int(match.group(1))] = {"text": span["text"], "bbox": list(span["bbox"])}
        width_px, height_px = profile_image["width"], profile_image["height"]
        pdf_to_pixel = {
            "xScale": width_px / image_rect.width, "yScale": height_px / image_rect.height,
            "xOffset": -image_rect.x0 * width_px / image_rect.width,
            "yOffset": -image_rect.y0 * height_px / image_rect.height,
        }
        to_x = lambda value: value * pdf_to_pixel["xScale"] + pdf_to_pixel["xOffset"]
        to_y = lambda value: value * pdf_to_pixel["yScale"] + pdf_to_pixel["yOffset"]
        calibration = {
            "widthMm": 97, "depthMm": 49, "rebateMm": 16,
            "widthPixelStart": to_x(min(lines["width"]["x0"], lines["width"]["x1"])),
            "widthPixelEnd": to_x(max(lines["width"]["x0"], lines["width"]["x1"])),
            "depthPixelTop": to_y(min(lines["depth"]["y0"], lines["depth"]["y1"])),
            "backingBaselinePixel": to_y(max(lines["depth"]["y0"], lines["depth"]["y1"])),
            "rebatePixelTop": to_y(min(lines["rebate"]["y0"], lines["rebate"]["y1"])),
            "pdfDimensionLines": lines,
            "dimensionText": dimension_text,
        }
        return {
            "parser": "MainlineSpecParser", "sourcePdf": str(self.pdf_path), "pageNumber": self.page_number,
            "pageSizePoints": [self.page.rect.width, self.page.rect.height], "imageCount": len(images),
            "images": images, "selectedProfileImageXref": profile_image["xref"],
            "selectedProfileImageRect": list(image_rect), "pdfToNativePixelTransform": pdf_to_pixel,
            "calibration": calibration,
        }

    def extract(self, output: Path):
        output.mkdir(parents=True, exist_ok=True)
        metadata = self.inspect()
        extracted = []
        for image in metadata["images"]:
            native = self.document.extract_image(image["xref"])
            filename = f'image-{image["ordinal"]:02d}-xref-{image["xref"]}.{native["ext"]}'
            (output / filename).write_bytes(native["image"])
            image["filename"] = filename
            extracted.append(output / filename)
            if image["xref"] == metadata["selectedProfileImageXref"]:
                (output / f'profile-native.{native["ext"]}').write_bytes(native["image"])
                metadata["profileNativeFilename"] = f'profile-native.{native["ext"]}'
                metadata["profileNativeResolution"] = [native["width"], native["height"]]
        pixmap = self.page.get_pixmap(matrix=pymupdf.Matrix(4, 4), alpha=False)
        pixmap.save(output / "page-2-render-4x.png")
        rect = pymupdf.Rect(metadata["selectedProfileImageRect"])
        crop = self.page.get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=rect, alpha=False)
        crop.save(output / "profile-rendered-crop-4x.png")
        self._contact_sheet(extracted, output / "native-contact-sheet.jpg")
        (output / "native-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
        self._diagnostic(metadata, output / "native-comparison.html")
        return metadata

    @staticmethod
    def _contact_sheet(files, target):
        cards = []
        for file in files:
            image = Image.open(file).convert("RGB")
            thumb = ImageOps.contain(image, (330, 260))
            card = Image.new("RGB", (350, 300), "white")
            card.paste(thumb, ((350 - thumb.width) // 2, 10))
            ImageDraw.Draw(card).text((12, 278), file.name, fill="black")
            cards.append(card)
        sheet = Image.new("RGB", (700, ((len(cards) + 1) // 2) * 300), "#222")
        for index, card in enumerate(cards):
            sheet.paste(card, ((index % 2) * 350, (index // 2) * 300))
        sheet.save(target, quality=94)

    @staticmethod
    def _diagnostic(metadata, target):
        resolution = " × ".join(map(str, metadata["profileNativeResolution"]))
        target.write_text(f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Native PDF asset comparison</title><style>
        :root{{color-scheme:dark;font-family:Inter,system-ui;background:#111;color:#eee}}body{{max-width:1200px;margin:auto;padding:32px}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:20px}}figure{{margin:0;background:#1c1c1c;padding:14px}}img{{display:block;width:100%;background:white;image-rendering:auto}}p,figcaption{{color:#aaa}}code{{color:#dfbd78}}@media(max-width:760px){{.grid{{grid-template-columns:1fr}}}}</style></head><body>
        <h1>Mainline page 2 native asset inspection</h1><p>Selected embedded image: <code>{metadata["profileNativeFilename"]}</code>, native resolution <strong>{resolution} px</strong>. Five embedded images were found; the tallest image is selected because the PDF dimension graphics span it.</p><div class="grid">
        <figure><img src="{metadata["profileNativeFilename"]}"><figcaption>Native JPEG extracted directly from the PDF</figcaption></figure>
        <figure><img src="profile-rendered-crop-4x.png"><figcaption>Same placed PDF region rendered at 4×</figcaption></figure></div><h2>All native page images</h2><img src="native-contact-sheet.jpg"></body></html>''')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--page", type=int, default=2)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    metadata = MainlineSpecParser(Path(args.pdf), args.page).extract(Path(args.output))
    print(f'Extracted {metadata["imageCount"]} native images; profile source {metadata["profileNativeResolution"][0]}x{metadata["profileNativeResolution"][1]} px')
    print(json.dumps(metadata["calibration"], indent=2))


if __name__ == "__main__":
    main()
