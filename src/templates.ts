// Template resolution. Templates are Pandoc .latex files accompanied by
// supporting assets (.cls, .sty, fonts, images). Three sources are
// searched in ascending priority: built-in, global (~/.inkwell/templates),
// and project-local (.inkwell/templates). The highest-priority match wins.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { findInkwellRoot } from "./config";

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
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function builtinTemplatesDir(): string {
  return path.join(__dirname, "..", "templates");
}

function projectTemplatesDir(
  documentUri: vscode.Uri
): string | undefined {
  const root = findInkwellRoot(documentUri);
  if (!root) return undefined;
  const dir = path.join(root, ".inkwell", "templates");
  return fs.existsSync(dir) ? dir : undefined;
}

function readManifest(templateDir: string, fallbackId: string): TemplateManifest {
  const manifestPath = path.join(templateDir, "template.json");
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    return { name: parsed.name || fallbackId, ...parsed };
  } catch {
    return { name: fallbackId };
  }
}

function findPandocTemplate(templateDir: string): string | undefined {
  const entries = fs.readdirSync(templateDir);
  const latex = entries.find((f) => f.endsWith(".latex"));
  if (latex) return path.join(templateDir, latex);
  const tex = entries.find(
    (f) => f.endsWith(".tex") && f.startsWith("template")
  );
  if (tex) return path.join(templateDir, tex);
  return undefined;
}

function findSupportingFiles(templateDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        SUPPORTING_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        !entry.name.endsWith(".latex")
      ) {
        files.push(full);
      }
    }
  };
  walk(templateDir);
  return files;
}

function scanDir(dir: string): Map<string, string> {
  const templates = new Map<string, string>();
  if (!fs.existsSync(dir)) return templates;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      templates.set(entry.name, path.join(dir, entry.name));
    }
  }
  return templates;
}

export function listTemplates(
  documentUri?: vscode.Uri
): Map<string, ResolvedTemplate> {
  const result = new Map<string, ResolvedTemplate>();

  const builtinDir = builtinTemplatesDir();
  const defaultTemplate = path.join(builtinDir, "inkwell.latex");
  if (fs.existsSync(defaultTemplate)) {
    result.set("inkwell", {
      id: "inkwell",
      manifest: { name: "Inkwell Default", description: "Built-in template with theorem environments, code highlighting, and title page", engine: "xelatex" },
      dir: builtinDir,
      pandocTemplate: defaultTemplate,
      supportingFiles: [],
    });
  }

  for (const [id, dir] of scanDir(builtinDir)) {
    if (result.has(id)) continue;
    const manifest = readManifest(dir, id);
    const pandocTemplate = findPandocTemplate(dir);
    result.set(id, {
      id,
      manifest,
      dir,
      pandocTemplate: pandocTemplate || defaultTemplate,
      supportingFiles: findSupportingFiles(dir),
    });
  }

  for (const [id, dir] of scanDir(globalTemplatesDir())) {
    const manifest = readManifest(dir, id);
    const pandocTemplate = findPandocTemplate(dir);
    if (!pandocTemplate && result.has(id)) continue;
    result.set(id, {
      id,
      manifest,
      dir,
      pandocTemplate: pandocTemplate || defaultTemplate,
      supportingFiles: findSupportingFiles(dir),
    });
  }

  if (documentUri) {
    const projDir = projectTemplatesDir(documentUri);
    if (projDir) {
      for (const [id, dir] of scanDir(projDir)) {
        const manifest = readManifest(dir, id);
        const pandocTemplate = findPandocTemplate(dir);
        if (!pandocTemplate && result.has(id)) continue;
        result.set(id, {
          id,
          manifest,
          dir,
          pandocTemplate: pandocTemplate || defaultTemplate,
          supportingFiles: findSupportingFiles(dir),
        });
      }
    }
  }

  return result;
}

export function resolveTemplate(
  templateId: string,
  documentUri?: vscode.Uri
): ResolvedTemplate | undefined {
  const all = listTemplates(documentUri);
  return all.get(templateId);
}

const outputChannel = vscode.window.createOutputChannel("Inkwell Templates");

// Resolution order: frontmatter template field > manifest.json > built-in default.
// This lets per-document overrides coexist with a project-level default.
export function getTemplateForDocument(
  document: vscode.TextDocument
): ResolvedTemplate {
  const text = document.getText();
  const fmTemplate = extractFrontmatterTemplate(text);

  if (fmTemplate) {
    const resolved = resolveTemplate(fmTemplate, document.uri);
    if (resolved) {
      outputChannel.appendLine(
        `[template] ${path.basename(document.fileName)}: using frontmatter template "${fmTemplate}"`
      );
      return resolved;
    }
    outputChannel.appendLine(
      `[template] ${path.basename(document.fileName)}: frontmatter says "${fmTemplate}" but template not found, falling through`
    );
  }

  const root = findInkwellRoot(document.uri);
  if (root) {
    const manifestPath = path.join(root, ".inkwell", "manifest.json");
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw);
      if (manifest.template) {
        const resolved = resolveTemplate(manifest.template, document.uri);
        if (resolved) {
          outputChannel.appendLine(
            `[template] ${path.basename(document.fileName)}: using manifest template "${manifest.template}" (${manifestPath})`
          );
          return resolved;
        }
      }
    } catch {}
  }

  outputChannel.appendLine(
    `[template] ${path.basename(document.fileName)}: using built-in default`
  );
  const fallback = resolveTemplate("inkwell", document.uri);
  if (!fallback) {
    throw new Error(
      "Inkwell built-in template not found. The extension may be corrupted; try reinstalling."
    );
  }
  return fallback;
}

function extractFrontmatterTemplate(text: string): string | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const templateMatch = match[1].match(/^template:\s*['"]?([^#'"}\r\n]+?)['"]?\s*$/m);
  return templateMatch ? templateMatch[1].trim() : undefined;
}

export function copySupportingFiles(
  template: ResolvedTemplate,
  targetDir: string
): void {
  for (const file of template.supportingFiles) {
    const relative = path.relative(template.dir, file);
    const dest = path.join(targetDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }
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
  for (const [id, tmpl] of templates) {
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
