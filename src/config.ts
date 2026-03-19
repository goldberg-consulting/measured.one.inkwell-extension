// Project configuration. An Inkwell project is identified by the
// presence of a .inkwell/ directory; this module walks up from the
// document to find it, reads manifest.json for template and settings,
// and locates bibliography files and defaults.yaml for Pandoc.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export interface InkwellManifest {
  name?: string;
  template?: string;
  documentSettings?: {
    fontSize?: number;
    lineSpacing?: number;
    paperSize?: string;
    fontFamily?: string;
  };
}

export function saveManifestField(
  projectRoot: string,
  field: string,
  value: string
): void {
  const manifestPath = path.join(projectRoot, ".inkwell", "manifest.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {}
  manifest[field] = value;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

export function findInkwellRoot(
  documentUri: vscode.Uri
): string | undefined {
  let dir = path.dirname(documentUri.fsPath);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, ".inkwell"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

export function loadManifest(projectRoot: string): InkwellManifest {
  const manifestPath = path.join(projectRoot, ".inkwell", "manifest.json");
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function findBibFiles(projectRoot: string): string[] {
  const results: string[] = [];
  const bibDirs = [
    projectRoot,
    path.join(projectRoot, "references"),
    path.join(projectRoot, ".inkwell", "references"),
  ];
  for (const dir of bibDirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".bib")) {
          results.push(path.join(dir, f));
        }
      }
    } catch {}
  }
  return results;
}

export function findDefaultsYaml(projectRoot: string): string | undefined {
  const candidate = path.join(projectRoot, "defaults.yaml");
  return fs.existsSync(candidate) ? candidate : undefined;
}
