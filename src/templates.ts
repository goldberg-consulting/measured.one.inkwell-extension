// Template resolution. Templates are Pandoc .latex files accompanied by
// supporting assets (.cls, .sty, fonts, images). Three sources are
// searched in ascending priority: built-in, global (~/.inkwell/templates),
// and project-local (.inkwell/templates). The highest-priority match wins.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { findInkwellRoot, getDocumentConfig } from "./config";
import { TemplateAssetLease, templateAssetCache } from "./template-assets";
import { ResolutionSnapshot, freezeResolution, resolutionCache } from "./resolution-cache";

export type PdfEngine = "xelatex" | "pdflatex" | "lualatex";

export interface TemplateFeature {
  pattern: string;
  syntax: string;
  description: string;
}

export interface TemplateManifest {
  name: string;
  description?: string;
  author?: string;
  documentclass?: string;
  engine?: PdfEngine;
  variables?: Record<string, string>;
  features?: TemplateFeature[];
}

export interface ResolvedTemplate {
  id: string;
  manifest: TemplateManifest;
  dir: string;
  pandocTemplate: string;
  supportingFiles: string[];
}

const SUPPORTING_EXTENSIONS = new Set([
  ".cls",
  ".sty",
  ".bst",
  ".bib",
  ".def",
  ".fd",
  ".cfg",
  ".clo",
  ".ldf",
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".eps",
  ".svg",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
]);

function globalTemplatesDir(): string {
  const dir = path.join(os.homedir(), ".inkwell", "templates");
  return dir;
}

function builtinTemplatesDir(): string {
  return path.join(__dirname, "..", "templates");
}

function readManifest(templateDir: string, fallbackId: string, snapshot: ResolutionSnapshot): TemplateManifest {
  const manifestPath = path.join(templateDir, "template.json");
  if (!snapshot.file(manifestPath, templateDir)) return { name: fallbackId };
  try {
    const descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const contents = fs.readFileSync(descriptor);
      snapshot.content(manifestPath, contents);
      const parsed = JSON.parse(contents.toString("utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed, name: parsed.name || fallbackId } : { name: fallbackId };
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (!(error instanceof SyntaxError)) snapshot.cacheable = false;
    return { name: fallbackId };
  }
}

function scanTemplate(templateDir: string, id: string, snapshot: ResolutionSnapshot): { manifest: TemplateManifest; pandocTemplate?: string; supportingFiles: string[] } {
  const supportingFiles: string[] = [], candidates: string[] = [];
  const walk = (directory: string) => {
    if (!snapshot.directory(directory, templateDir)) return;
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (snapshot.file(full, templateDir)) {
          if (directory === templateDir && (entry.name.endsWith(".latex") || (entry.name.startsWith("template") && entry.name.endsWith(".tex")))) candidates.push(full);
          if (SUPPORTING_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) supportingFiles.push(full);
        }
      }
    } catch { snapshot.cacheable = false; }
  };
  walk(templateDir);
  return { manifest: readManifest(templateDir, id, snapshot), pandocTemplate: candidates.find(file => file.endsWith(".latex")) || candidates[0], supportingFiles };
}

function scanDir(directory: string, boundary: string, snapshot: ResolutionSnapshot): Map<string, string> {
  const templates = new Map<string, string>();
  // A selected project/home boundary may be an intentional root alias. Keep
  // its identity observed, then validate ordinary child directories against
  // the physical boundary; selected templates and support dirs stay strict.
  const physicalBoundary = snapshot.inspect(boundary, false).realPath;
  if (!physicalBoundary || !snapshot.directory(directory, physicalBoundary)) return templates;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && snapshot.directory(full, directory)) templates.set(entry.name, full);
    }
  } catch { snapshot.cacheable = false; }
  return templates;
}

export function listTemplates(documentUri?: vscode.Uri): Map<string, ResolvedTemplate> {
  resolutionCache.start();
  const builtinDir = builtinTemplatesDir(), globalDir = globalTemplatesDir();
  // Nearest-root template policy intentionally differs from artifact workspace
  // preference. Root resolution also observes missing nested .inkwell markers.
  const projectRoot = documentUri ? findInkwellRoot(documentUri) : undefined;
  const headless = process.env.INKWELL_HEADLESS === "1";
  const entries = resolutionCache.get(`templates:${JSON.stringify([builtinDir, globalDir, projectRoot, headless])}`, snapshot => {
    const result = new Map<string, ResolvedTemplate>();
    const defaultTemplate = path.join(builtinDir, "inkwell.latex");
    if (snapshot.directory(builtinDir) && snapshot.file(defaultTemplate, builtinDir)) {
      const defaultEntry: ResolvedTemplate = {
        id: "inkwell", manifest: { name: "Inkwell Default", description: "Clean single-column article with theorem environments, code highlighting, and title page", engine: "xelatex" },
        dir: builtinDir, pandocTemplate: defaultTemplate, supportingFiles: [],
      };
      result.set("inkwell", defaultEntry); result.set("default", { ...defaultEntry, id: "default" });
    }
    const sources: [string, string, boolean][] = [[builtinDir, builtinDir, true]];
    if (!headless) sources.push([globalDir, os.homedir(), false]);
    if (projectRoot) sources.push([path.join(projectRoot, ".inkwell", "templates"), projectRoot, false]);
    for (const [directory, boundary, builtin] of sources) {
      for (const [id, dir] of scanDir(directory, boundary, snapshot)) {
        if (builtin && result.has(id)) continue;
        const scanned = scanTemplate(dir, id, snapshot);
        if (!builtin && !scanned.pandocTemplate && result.has(id)) continue;
        result.set(id, { id, dir, ...scanned, pandocTemplate: scanned.pandocTemplate || defaultTemplate });
      }
    }
    return freezeResolution([...result.entries()]);
  });
  // Freezing a Map does not protect its entries: callers get a fresh container.
  return new Map(entries);
}

export function resolveTemplate(
  templateId: string,
  documentUri?: vscode.Uri
): ResolvedTemplate | undefined {
  const all = listTemplates(documentUri);
  return all.get(templateId);
}

// Lazily created so merely importing this module (e.g. from the compiler)
// does not register an output channel before the extension is even active.
let _outputChannel: vscode.OutputChannel | undefined;
function outputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel("Inkwell Templates");
  }
  return _outputChannel;
}

// Resolution order: frontmatter template field > manifest.json > built-in default.
// This lets per-document overrides coexist with a project-level default.
export function getTemplateForDocument(
  document: vscode.TextDocument
): ResolvedTemplate {
  const config = getDocumentConfig(document.getText(), document.uri.fsPath);
  const resolved = resolveTemplate(config.template, document.uri);
  if (resolved) {
    outputChannel().appendLine(`[template] ${path.basename(document.uri.fsPath)}: using resolved template "${config.template}"`);
    return resolved;
  }
  outputChannel().appendLine(`[template] Template "${config.template}" is unavailable; using built-in default. Check the document configuration diagnostic.`);
  const fallback = resolveTemplate("inkwell", document.uri);
  if (!fallback) throw new Error("Inkwell built-in template is missing. Run Setup / Repair or reinstall the extension.");
  return fallback;
}

export function copySupportingFiles(
  template: ResolvedTemplate,
  targetDir: string,
  resourceRoots: readonly string[] = []
): TemplateAssetLease {
  const builtins = builtinTemplatesDir();
  const relative = path.relative(builtins, template.dir);
  const isBuiltin = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  // If a project supplies a colliding resource, retain the exact existing
  // per-attempt copy/override behavior instead of changing search precedence.
  const hasCollision = template.supportingFiles.some(file => resourceRoots.some(root =>
    fs.existsSync(path.join(root, path.relative(template.dir, file)))));
  if (isBuiltin && !hasCollision) {
    const lease = templateAssetCache.acquire(template.dir, template.supportingFiles);
    if (lease) return lease;
  }
  for (const file of template.supportingFiles) {
    const relative = path.relative(template.dir, file);
    const dest = path.join(targetDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }
  return { directory: targetDir, cacheHit: false, release() {} };
}

export function collectAllFeatures(
  documentUri?: vscode.Uri
): { templateId: string; templateName: string; feature: TemplateFeature }[] {
  const all = listTemplates(documentUri);
  const results: { templateId: string; templateName: string; feature: TemplateFeature }[] = [];
  for (const [id, tmpl] of all) {
    for (const f of tmpl.manifest.features || []) {
      results.push({ templateId: id, templateName: tmpl.manifest.name, feature: f });
    }
  }
  return results;
}

export async function selectTemplateCommand(
  documentUri?: vscode.Uri
): Promise<string | undefined> {
  const templates = listTemplates(documentUri);

  const items: vscode.QuickPickItem[] = [];
  const seen = new Set<string>();
  for (const [id, tmpl] of templates) {
    if (id === "default") continue;
    if (seen.has(tmpl.manifest.name)) continue;
    seen.add(tmpl.manifest.name);
    items.push({
      label: tmpl.manifest.name,
      description: id,
      detail: tmpl.manifest.description || tmpl.dir,
    });
  }

  if (!items.length) {
    vscode.window.showInformationMessage(
      "No templates found. Add template directories to ~/.inkwell/templates/"
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a LaTeX template",
  });

  return picked?.description;
}
