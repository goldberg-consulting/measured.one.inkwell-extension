// Project configuration. An Inkwell project is identified by the
// presence of a .inkwell/ directory; this module walks up from the
// document to find it, reads manifest.json for template and settings,
// and locates bibliography files and defaults.yaml for Pandoc.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { DocumentConfig, resolveDocumentConfig } from "./document-config";
import { ResolutionSnapshot, isPathWithin, resolutionCache } from "./resolution-cache";
import { ResolvedReferences, resolveBibliographyConfiguration } from "./bibliography-service";
export type { ResolvedReferences } from "./bibliography-service";

export interface InkwellManifest {
  [key: string]: unknown;
  schemaVersion?: number;
  defaults?: Record<string, unknown>;
  managedFiles?: Record<string, unknown>;
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
  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    try {
      manifest = JSON.parse(raw);
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Expected a JSON object");
    } catch {
      const backup = `${manifestPath}.malformed-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12)}.bak`;
      if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup, fs.constants.COPYFILE_EXCL);
      throw new Error(`The project manifest is malformed. Original preserved; backup: ${backup}. Repair it before changing project settings.`);
    }
  }
  manifest[field] = value;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temporary, manifestPath);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Resolve absent descendants through their nearest existing physical ancestor. */
function physicalLocation(directory: string, snapshot: ResolutionSnapshot): string | undefined {
  let current = directory;
  const missing: string[] = [];
  while (true) {
    const observed = snapshot.inspect(current, false);
    if (observed.realPath) return path.join(observed.realPath, ...missing.reverse());
    if (observed.signature !== "missing") return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    missing.push(path.basename(current)); current = parent;
  }
}

function hasInkwellMarker(directory: string, snapshot: ResolutionSnapshot): boolean {
  const boundary = snapshot.inspect(directory, false);
  const marker = snapshot.inspect(path.join(directory, ".inkwell"), false);
  // The chosen project/workspace root may be an intentional filesystem alias.
  // The marker itself must remain a real directory contained in that root.
  return marker.directory && !!marker.realPath && !!boundary.realPath && isPathWithin(boundary.realPath, marker.realPath);
}

function nearestInkwellRoot(directory: string, snapshot: ResolutionSnapshot): string | undefined {
  const source = physicalLocation(directory, snapshot);
  let dir = directory;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const ancestor = snapshot.inspect(dir, false);
    if (source && ancestor.realPath && isPathWithin(ancestor.realPath, source) &&
        hasInkwellMarker(dir, snapshot)) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

export function findInkwellRoot(documentUri: vscode.Uri): string | undefined {
  const directory = path.resolve(path.dirname(documentUri.fsPath));
  return resolutionCache.get(`nearest:${directory}`, snapshot => nearestInkwellRoot(directory, snapshot));
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
  resolutionCache.start();
  const normalized = path.resolve(sourcePath), directory = path.dirname(normalized);
  // Workspace assignment is cheap live state, and is part of the key. It never
  // waits for a filesystem watcher to notice editor workspace changes.
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sourcePath));
  const wsRoot = folder ? path.resolve(folder.uri.fsPath) : undefined;
  return resolutionCache.get(`project:${JSON.stringify([directory, wsRoot])}`, snapshot => {
    if (wsRoot && isPathWithin(wsRoot, normalized)) {
      const source = physicalLocation(directory, snapshot), workspace = snapshot.inspect(wsRoot, false);
      if (source && workspace.realPath && isPathWithin(workspace.realPath, source) &&
          hasInkwellMarker(wsRoot, snapshot)) return wsRoot;
    }
    return nearestInkwellRoot(directory, snapshot) ?? directory;
  });
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
      for (const f of fs.readdirSync(dir).sort()) {
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
      for (const f of fs.readdirSync(dir).sort()) {
        if (f.endsWith(".csl")) return path.join(dir, f);
      }
    } catch {}
  }
  return undefined;
}

/** Read-only boundary shared by every document consumer. Rendering never writes a manifest. */
export function getDocumentConfig(text: string, sourceFile: string): DocumentConfig {
  const root = getInkwellProjectRoot(sourceFile);
  const manifestPath = path.join(root, ".inkwell", "manifest.json");
  let manifest: Record<string, unknown> = {};
  let manifestError: string | undefined;
  try {
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
      manifest = parsed;
    }
  } catch (error) { manifestError = `Cannot read project manifest: ${String(error)}. Run Setup / Repair to preserve a backup and resolve it.`; }
  const defaultsPath = findDefaultsYaml(root);
  let defaultsYaml: string | undefined;
  try { if (defaultsPath) defaultsYaml = fs.readFileSync(defaultsPath, "utf8"); } catch (error) { manifestError = `Cannot read project defaults: ${String(error)}`; }
  const settings = vscode.workspace.getConfiguration?.("inkwell", vscode.Uri.file(sourceFile));
  const editorDefaults: Record<string, unknown> = { ...(settings?.get<Record<string, unknown>>("documentDefaults") || {}) };
  const display = settings?.get<string>("defaultCodeDisplay");
  const inspected = settings?.inspect?.<string>("defaultCodeDisplay");
  const explicitlyConfigured = inspected
    ? [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue,
      inspected.globalLanguageValue, inspected.workspaceLanguageValue, inspected.workspaceFolderLanguageValue].some(value => value !== undefined)
    : display !== undefined && display !== "output";
  if (explicitlyConfigured) editorDefaults.defaultCodeDisplay = display;
  const config = resolveDocumentConfig({ text, sourcePath: sourceFile, manifest, manifestPath, defaultsYaml, defaultsPath, editorDefaults });
  if (!manifestError) return config;
  return { ...config, diagnostics: [...config.diagnostics, {
    code: "manifest-invalid", severity: "error", message: manifestError,
    sourcePath: manifestPath, line: 1, column: 1,
  }] };
}

/** Compatibility boundary shared by preview and compiler. */
export function getResolvedReferences(config: DocumentConfig, sourceFile: string): ResolvedReferences {
  return resolveBibliographyConfiguration(config, sourceFile, getInkwellProjectRoot(sourceFile));
}
