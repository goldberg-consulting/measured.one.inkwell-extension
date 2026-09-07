// Project configuration. An Inkwell project is identified by the
// presence of a .inkwell/ directory; this module walks up from the
// document to find it, reads manifest.json for template and settings,
// and locates bibliography files and defaults.yaml for Pandoc.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { DocumentConfig, resolveDocumentConfig } from "./document-config";

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

export interface ResolvedReferences {
  readonly bibliography: readonly string[];
  readonly csl?: string;
  readonly scope: "document" | "section";
  readonly linkCitations: boolean;
  readonly referencesHeading?: string;
  readonly diagnostics: readonly { code: string; severity: "error" | "warning"; message: string; sourcePath: string; line: number; column: number }[];
}

/** Declared files first, then sorted project discovery; explicit [] disables discovery. */
export function getResolvedReferences(config: DocumentConfig, sourceFile: string): ResolvedReferences {
  const root = getInkwellProjectRoot(sourceFile);
  const metadata = config.compatibility;
  const declared = metadata.bibliography;
  const paths = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared.filter((p): p is string => typeof p === "string") : [];
  const diagnostics: { code: string; severity: "error" | "warning"; message: string; sourcePath: string; line: number; column: number }[] = [];
  const resolve = (file: string, documentDeclared: boolean): string => {
    if (path.isAbsolute(file)) return path.normalize(file);
    const fromDocument = path.resolve(path.dirname(sourceFile), file);
    if (documentDeclared && fs.existsSync(fromDocument)) return fromDocument;
    const fromProject = path.resolve(root, file);
    if (fs.existsSync(fromProject) || !documentDeclared) return fromProject;
    return fromDocument;
  };
  // An explicit document key is the authoritative path context. Project/defaults
  // declarations resolve from the project even for nested source documents.
  const bibliographySource = config.provenance["references.bibliography"];
  const documentDeclared = bibliographySource?.source === "document" || Object.hasOwn(config.documentMetadata, "bibliography");
  const bibliography = [...new Set([
    ...paths.map(file => resolve(file, documentDeclared)),
    ...(Array.isArray(declared) && declared.length === 0 ? [] : findBibFiles(root)),
  ])];
  for (const file of bibliography) if (!fs.existsSync(file)) diagnostics.push({
    code: "bibliography-missing", severity: "error", message: `Bibliography file is missing: ${file}`,
    sourcePath: bibliographySource?.sourcePath || sourceFile, line: bibliographySource?.line || 1, column: bibliographySource?.column || 1,
  });
  let csl: string | undefined;
  if (typeof metadata.csl === "string") {
    csl = resolve(metadata.csl, config.provenance["references.csl"]?.source === "document" || Object.hasOwn(config.documentMetadata, "csl"));
    if (!fs.existsSync(csl)) csl = findCslFile(root, metadata.csl) || csl;
    if (!fs.existsSync(csl)) {
      const source = config.provenance["references.csl"];
      diagnostics.push({ code: "csl-missing", severity: "error", message: `CSL style is missing: ${csl}`, sourcePath: source?.sourcePath || sourceFile, line: source?.line || 1, column: source?.column || 1 });
    }
  } else {
    csl = path.join(__dirname, "..", "csl", "inkwell-numeric.csl");
  }
  return Object.freeze({ bibliography: Object.freeze(bibliography), csl,
    scope: config.references.scope,
    linkCitations: metadata["link-citations"] !== false,
    referencesHeading: typeof metadata["reference-section-title"] === "string" ? metadata["reference-section-title"] : undefined,
    diagnostics: Object.freeze(diagnostics),
  });
}
