import fs from "node:fs/promises";
import path from "node:path";
import {csvParse, autoType} from "d3-dsv";
import {JSDOM} from "jsdom";
import sharp from "sharp";

export const document = new JSDOM("<!doctype html><html><body></body></html>").window.document;
export async function readOutcomes() {
  return csvParse(await fs.readFile(new URL("./outcomes.csv", import.meta.url), "utf8"), autoType);
}
export async function savePlot(plot, name) {
  const output = process.env.INKWELL_OUTPUT_DIR;
  if (!output) throw new Error("Run this file from its Inkwell document.");
  // Rasterize the SVG once so the same figure works in preview and XeLaTeX.
  await sharp(Buffer.from(plot.outerHTML), {density: 220}).flatten({background: "white"})
    .png().toFile(path.join(output, `${name}.png`));
}
