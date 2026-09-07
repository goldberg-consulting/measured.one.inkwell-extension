// Required packaged runtime assets. Keep this explicit so a missing file is detectable.
import * as fs from "fs";
import * as path from "path";

export interface AssetDiagnostic { path: string; message: string; severity: "error" | "warning" }

/** Resolve each existing ancestor, rejecting links that escape the selected root. */
export function resolveContainedPath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0") ||
      relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe relative path: ${relative}`);
  }
  const realRoot = fs.realpathSync(root);
  let current = path.resolve(root);
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      try { fs.lstatSync(current); throw new Error(`Broken symbolic link: ${current}`); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
      continue;
    }
    const real = fs.realpathSync(current);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`Path escapes the project root: ${current}`);
    const stat = fs.statSync(current);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Path is not a regular file or directory: ${current}`);
  }
  return current;
}

export function validateBundledAssets(assetRoot: string): AssetDiagnostic[] {
  const diagnostics: AssetDiagnostic[] = [];
  for (const relative of BUNDLED_ASSET_PATHS) {
    try {
      const file = resolveContainedPath(assetRoot, relative);
      const stat = fs.statSync(file);
      if (!stat.isFile() || !stat.size) throw new Error("required file is missing or empty");
      if (relative.endsWith(".json")) {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid JSON object");
      }
    } catch (error: any) {
      diagnostics.push({ path: relative, message: `Bundled asset ${relative}: ${error.message || String(error)}`, severity: "error" });
    }
  }
  return diagnostics;
}

export const BUNDLED_ASSET_PATHS: readonly string[] = [
  ".cursor/agents/inkwell-guide.md",
  "csl/inkwell-numeric.csl",
  "docs/style.md",
  "examples/demo-default.md",
  "examples/demo-eth-report.md",
  "examples/demo-hipster-cv.md",
  "examples/demo-ludus.md",
  "examples/demo-python-report.md",
  "examples/demo-rho.md",
  "examples/demo-rmxaa.md",
  "examples/demo-tmsce.md",
  "examples/demo-tufte-book-vdqi.md",
  "examples/demo-tufte.md",
  "examples/requirements.txt",
  "filters/body-typography.lua",
  "filters/section-bibliographies.lua",
  "guide.md",
  "out/extension.js",
  "package.json",
  "requirements-latex.txt",
  "templates/eth-report/eth-report.latex",
  "templates/eth-report/ivt-style/ivt-eng.bst",
  "templates/eth-report/ivt-style/ivt-unsrt-eng.bst",
  "templates/eth-report/ivt-style/standard.cls",
  "templates/eth-report/ivt-style/trb.bst",
  "templates/eth-report/template.json",
  "templates/hipster-cv/goldberg-consulting-logo.png",
  "templates/hipster-cv/hipster-cv.latex",
  "templates/hipster-cv/simplehipstercv.cls",
  "templates/hipster-cv/simplehipstercv.sty",
  "templates/hipster-cv/template.json",
  "templates/inkwell.latex",
  "templates/kth-letter/kth-letter-site.cfg",
  "templates/kth-letter/kth-letter.cls",
  "templates/kth-letter/kth-letter.latex",
  "templates/kth-letter/kth_cmyk_electr_engine.eps",
  "templates/kth-letter/kth_cmyk_electr_engine.pdf",
  "templates/kth-letter/template.json",
  "templates/ludus/logo.png",
  "templates/ludus/ludus.latex",
  "templates/ludus/ludusofficial.cls",
  "templates/ludus/main.tex",
  "templates/ludus/references.bib",
  "templates/ludus/template.json",
  "templates/rho/example.m",
  "templates/rho/figures/Example.pdf",
  "templates/rho/figures/example2.pdf",
  "templates/rho/logo.png",
  "templates/rho/main.tex",
  "templates/rho/rho-class/README.md",
  "templates/rho/rho-class/rho.cls",
  "templates/rho/rho-class/rhobabel.sty",
  "templates/rho/rho-class/rhoenvs.sty",
  "templates/rho/rho.bib",
  "templates/rho/rho.latex",
  "templates/rho/template.json",
  "templates/rmxaa/RMxAA.bib",
  "templates/rmxaa/RMxAA_main.tex",
  "templates/rmxaa/RMxAA_main_light.tex",
  "templates/rmxaa/RMxAC.bib",
  "templates/rmxaa/rmaa-rho-class/README.md",
  "templates/rmxaa/rmaa-rho-class/RMXAA-horizontal-amarillo.jpg",
  "templates/rmxaa/rmaa-rho-class/RMXAA-horizontal-blanco.jpg",
  "templates/rmxaa/rmaa-rho-class/RMXAA-horizontal-rojo.jpg",
  "templates/rmxaa/rmaa-rho-class/astroads.bst",
  "templates/rmxaa/rmaa-rho-class/caption.sty",
  "templates/rmxaa/rmaa-rho-class/rhobabel.sty",
  "templates/rmxaa/rmaa-rho-class/rhoenvs.sty",
  "templates/rmxaa/rmaa-rho-class/rmaa-rho.cls",
  "templates/rmxaa/rmaa-rho-class/rmaa-rho_light.cls",
  "templates/rmxaa/rmaa-rho-class/rmaa.bst",
  "templates/rmxaa/rmaa-rho-class/rmac-rho-abs.cls",
  "templates/rmxaa/rmaa-rho-class/rmac-rho.cls",
  "templates/rmxaa/rmaa-rho-class/rmao-rho.cls",
  "templates/rmxaa/rmaa-rho-class/rmxaa-horizontal-azul.jpg",
  "templates/rmxaa/rmaa-rho-class/rmxaa-horizontal-azul.png",
  "templates/rmxaa/rmxaa.latex",
  "templates/rmxaa/template.json",
  "templates/tmsce/sample_paper.tex",
  "templates/tmsce/template.json",
  "templates/tmsce/tmsce.cls",
  "templates/tmsce/tmsce.latex",
  "templates/tufte-book-vdqi/template.json",
  "templates/tufte-book-vdqi/tufte-book-vdqi.latex",
  "templates/tufte/template.json",
  "templates/tufte/tufte.latex"
];
