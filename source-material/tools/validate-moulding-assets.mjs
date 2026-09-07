#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const root = process.cwd();
const readJson = async (file) =>
  JSON.parse(await readFile(path.join(root, file), "utf8"));
const exists = async (file) => {
  try {
    await access(path.join(root, file), constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const mainline = await readJson("src/mouldings/mainlineMaterials.json");
const centrado = await readJson("src/mouldings/centradoMouldings.json");
const failures = [];

for (const [sku, material] of Object.entries(mainline)) {
  const base = `public/assets/mouldings/${sku}/variants/${material.variant}`;
  for (const name of ["basecolor.jpg", "roughness.jpg", "bump.jpg", "manifest.json"])
    if (!(await exists(`${base}/${name}`))) failures.push(`${sku}: missing ${name}`);
  if (!(await exists(`public/assets/mouldings/${sku}/catalogue/source.png`)))
    failures.push(`${sku}: missing catalogue profile source`);
}

for (const moulding of centrado) {
  const base = `public/assets/mouldings/${moulding.sku}`;
  for (const name of ["profile.json", "base-texture.jpg", "base-bump.jpg"])
    if (!(await exists(`${base}/${name}`))) failures.push(`${moulding.sku}: missing ${name}`);
  if (moulding.accentWidthMm)
    for (const name of ["accent-texture.jpg", "accent-bump.jpg"])
      if (!(await exists(`${base}/${name}`))) failures.push(`${moulding.sku}: missing ${name}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${Object.keys(mainline).length} Mainline and ${centrado.length} Centrado mouldings.`);
}
