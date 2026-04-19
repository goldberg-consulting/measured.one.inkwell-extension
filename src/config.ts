// Project configuration. An Inkwell project is identified by the
// presence of a .inkwell/ directory; this module walks up from the
// document to find it, reads manifest.json for template and settings,
// and locates bibliography files and defaults.yaml for Pandoc.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

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

/**
 * Inkwell project root for artifacts (`outputs/`, `mermaid/`, `compiled/`) and
 * code-block cwd. Prefers the **VS Code workspace folder** when it contains
 * `.inkwell/` and the file lies under that folder—so a single repo root next
 * to `.cursor/` wins over a stray nested `.inkwell/` beside a deep `.md` file.
 * Otherwise falls back to `findInkwellRoot` (walk upward). If none matches,
 * uses the document's directory.
 */
export function getInkwellProjectRoot(sourcePath: string): string {
  const uri = vscode.Uri.file(sourcePath);
  const normalized = path.normalize(sourcePath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) {
    const wsRoot = folder.uri.fsPath;
    const underWs =
      normalized === wsRoot || normalized.startsWith(wsRoot + path.sep);
    if (underWs && fs.existsSync(path.join(wsRoot, ".inkwell"))) {
      return wsRoot;
    }
  }
  return findInkwellRoot(uri) ?? path.dirname(normalized);
}

/**
 * Stable subdirectory name under `.inkwell/outputs/` (and compiled filename
 * stem) derived from the source path relative to the project root.
 */
export function getInkwellDocumentKey(
  sourceFile: string,
  projectRoot: string,
): string {
  let rel = path.relative(projectRoot, sourceFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const h = crypto.createHash("sha256").update(sourceFile).digest("hex").slice(0, 16);
    return `__ext_${h}`;
  }
  rel = rel.replace(/\\/g, "/");
  const ext = path.extname(rel);
  const without = ext ? rel.slice(0, -ext.length) : rel;
  const key = without.replace(/\//g, "--");
  return key || "__root";
}

/** Per-document code-block cache: `.inkwell/outputs/<key>/` */
export function getInkwellOutputsDir(sourceFile: string): string {
  const projectRoot = getInkwellProjectRoot(sourceFile);
  const key = getInkwellDocumentKey(sourceFile, projectRoot);
  return path.join(projectRoot, ".inkwell", "outputs", key);
}

/** Injected markdown for Pandoc: `.inkwell/compiled/<key>.<ext>` */
export function getInkwellCompiledPath(sourceFile: string): string {
  const projectRoot = getInkwellProjectRoot(sourceFile);
  const key = getInkwellDocumentKey(sourceFile, projectRoot);
  const ext = path.extname(sourceFile) || ".md";
  return path.join(projectRoot, ".inkwell", "compiled", `${key}${ext}`);
}

/**
 * Resolve `file="..."` on code blocks: document-relative first, then project
 * root (so `.inkwell/scripts/foo.py` works from nested markdown paths).
 */
export function resolveBlockFilePath(
  fileRel: string,
  docDir: string,
  projectRoot: string,
): string {
  const fromDoc = path.normalize(path.resolve(docDir, fileRel));
  if (fs.existsSync(fromDoc)) return fromDoc;
  const fromRoot = path.normalize(path.resolve(projectRoot, fileRel));
  if (fs.existsSync(fromRoot)) return fromRoot;
  return fromDoc;
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

/**
 * Locate a CSL style file. If `name` is provided, try `<name>`, `<name>.csl`
 * in `.inkwell/csl/`, project root, and `references/`. Otherwise return the
 * first `.csl` found in `.inkwell/csl/` (deterministic by directory order).
 */
export function findCslFile(
  projectRoot: string,
  name?: string,
): string | undefined {
  const cslDirs = [
    path.join(projectRoot, ".inkwell", "csl"),
    path.join(projectRoot, "csl"),
    projectRoot,
    path.join(projectRoot, "references"),
  ];

  if (name) {
    const candidates = [name, name.endsWith(".csl") ? name : `${name}.csl`];
    for (const dir of cslDirs) {
      for (const c of candidates) {
        const full = path.isAbsolute(c) ? c : path.join(dir, c);
        if (fs.existsSync(full) && full.endsWith(".csl")) return full;
      }
    }
    if (path.isAbsolute(name) && fs.existsSync(name)) return name;
    return undefined;
  }

  for (const dir of cslDirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".csl")) return path.join(dir, f);
      }
    } catch {}
  }
  return undefined;
}
