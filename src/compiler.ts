// Compilation pipeline. Two modes: Pandoc (markdown -> PDF via XeLaTeX)
// and direct XeLaTeX (for .tex files). Both compile in an isolated temp
// directory so the user's working tree stays clean. The Pandoc path
// injects cached code block outputs, applies the selected template, and
// generates a dynamic LaTeX preamble from frontmatter style options.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { findInkwellRoot, findBibFiles, findDefaultsYaml } from "./config";
import { InkwellDiagnostics, CompileError } from "./diagnostics";
import { getTemplateForDocument, copySupportingFiles, PdfEngine, ResolvedTemplate, collectAllFeatures } from "./templates";
import { prepareForCompilation } from "./inject";
import { writePreambleFile } from "./preamble";

const exec = promisify(execFile);

const PANDOC_EXTENSIONS = [
  "raw_tex",
  "raw_attribute",
  "tex_math_dollars",
  "citations",
  "footnotes",
  "yaml_metadata_block",
  "implicit_figures",
  "link_attributes",
  "fenced_divs",
  "bracketed_spans",
  "pipe_tables",
  "smart",
].join("+");

// VS Code child processes do not inherit the user's shell PATH, so TeX
// binaries are invisible unless we reconstruct the search path ourselves.
function buildTexPath(): string {
  const base = ["/usr/local/bin", "/usr/bin"];
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/Library/TeX/texbin",
      "/opt/homebrew/bin",
      `${home}/Library/TinyTeX/bin/universal-darwin`,
      ...base,
      process.env.PATH,
    ].join(":");
  }
  return [
    ...base,
    `${home}/.TinyTeX/bin/x86_64-linux`,
    `${home}/.TinyTeX/bin/aarch64-linux`,
    "/usr/local/texlive/2024/bin/x86_64-linux",
    "/usr/local/texlive/2025/bin/x86_64-linux",
    "/usr/local/texlive/2026/bin/x86_64-linux",
    process.env.PATH,
  ].join(":");
}

const TEX_ENV = {
  ...process.env,
  PATH: buildTexPath(),
};

export interface CompileResult {
  success: boolean;
  pdfPath: string | undefined;
  errors: CompileError[];
  log: string;
  duration: number;
}

export type CompileMode = "pandoc" | "xelatex";

export function detectMode(document: vscode.TextDocument): CompileMode {
  const ext = path.extname(document.uri.fsPath).toLowerCase();
  if (ext === ".tex" || ext === ".latex") return "xelatex";
  return "pandoc";
}

export function isCompilable(document: vscode.TextDocument): boolean {
  const ext = path.extname(document.uri.fsPath).toLowerCase();
  const compilableExtensions = [".md", ".markdown", ".tex", ".latex", ".rst", ".org", ".txt"];
  return compilableExtensions.includes(ext) || document.languageId === "markdown" || document.languageId === "latex";
}

function getCacheDir(sourceFile: string): string {
  const hash = crypto.createHash("sha256").update(sourceFile).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "inkwell-vscode", hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const TEX_ARTIFACT_EXTS = new Set([
  ".pdf", ".aux", ".log", ".toc", ".lof", ".lot", ".out",
  ".idx", ".ind", ".ilg", ".bbl", ".blg", ".bcf", ".run.xml",
  ".nav", ".snm", ".fls", ".fdb_latexmk", ".synctex.gz",
]);

export function purgeAllCacheDirs(): void {
  const root = path.join(os.tmpdir(), "inkwell-vscode");
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
}

function purgeCompileArtifacts(cacheDir: string, baseName: string): void {
  for (const ext of TEX_ARTIFACT_EXTS) {
    const file = path.join(cacheDir, `${baseName}${ext}`);
    try { fs.unlinkSync(file); } catch {}
  }
}

const binaryCache = new Map<string, { result: string | undefined; ts: number }>();
const BINARY_CACHE_TTL = 60_000;

async function findBinary(name: string): Promise<string | undefined> {
  const cached = binaryCache.get(name);
  if (cached && Date.now() - cached.ts < BINARY_CACHE_TTL) return cached.result;

  const common = [`/usr/local/bin/${name}`, `/usr/bin/${name}`];
  const home = os.homedir();
  const platformPaths = process.platform === "darwin"
    ? [
        `/opt/homebrew/bin/${name}`,
        `/Library/TeX/texbin/${name}`,
        `${home}/Library/TinyTeX/bin/universal-darwin/${name}`,
        ...common,
      ]
    : [
        ...common,
        `${home}/.TinyTeX/bin/x86_64-linux/${name}`,
        `${home}/.TinyTeX/bin/aarch64-linux/${name}`,
      ];

  for (const p of platformPaths) {
    if (fs.existsSync(p)) {
      binaryCache.set(name, { result: p, ts: Date.now() });
      return p;
    }
  }
  try {
    const { stdout } = await exec("which", [name]);
    const trimmed = stdout.trim();
    if (trimmed) {
      binaryCache.set(name, { result: trimmed, ts: Date.now() });
      return trimmed;
    }
  } catch {}
  return undefined;
}

const compileLocks = new Map<string, Promise<CompileResult>>();

export function compile(
  document: vscode.TextDocument,
  outputPath?: string
): Promise<CompileResult> {
  const key = `${document.uri.fsPath}::${outputPath || ""}`;
  const existing = compileLocks.get(key);
  if (existing) return existing;

  const run = (async () => {
    const mode = detectMode(document);
    return mode === "xelatex"
      ? compileTeX(document, outputPath)
      : compilePandoc(document, outputPath);
  })();

  compileLocks.set(key, run);
  run.finally(() => compileLocks.delete(key));
  return run;
}

async function compileTeX(
  document: vscode.TextDocument,
  outputPath?: string
): Promise<CompileResult> {
  const start = Date.now();
  const sourceFile = document.uri.fsPath;
  const sourceDir = path.dirname(sourceFile);
  const baseName = path.basename(sourceFile, path.extname(sourceFile));

  const xelatex = await findBinary("xelatex");
  if (!xelatex) {
    return {
      success: false,
      pdfPath: undefined,
      errors: [{ line: undefined, message: "xelatex not found", severity: "error" }],
      log: "",
      duration: 0,
    };
  }

  const cacheDir = getCacheDir(sourceFile);
  const pdfOutput = outputPath || path.join(sourceDir, `${baseName}.pdf`);
  purgeCompileArtifacts(cacheDir, baseName);
  try { fs.unlinkSync(pdfOutput); } catch {}

  const tmpSource = path.join(cacheDir, path.basename(sourceFile));
  fs.writeFileSync(tmpSource, document.getText(), "utf-8");

  copySiblingFiles(sourceDir, cacheDir);
  const template = getTemplateForDocument(document);
  copySupportingFiles(template, cacheDir);

  const args = [
    "-interaction=nonstopmode",
    "-halt-on-error",
    `-output-directory=${cacheDir}`,
    tmpSource,
  ];

  const texEnv = {
    ...TEX_ENV,
    TEXINPUTS: [cacheDir, template.dir, sourceDir, ""].join(":"),
  };

  let stderr = "";
  let stdout = "";

  // Two passes required: the first resolves cross-references and TOC
  // entries; the second incorporates them into the final PDF.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const result = await exec(xelatex, args, {
        cwd: sourceDir,
        timeout: 120_000,
        env: texEnv,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: any) {
      if (err.stdout) stdout = err.stdout;
      if (err.stderr) stderr = err.stderr;
      if (pass === 0) break;
    }
  }

  // Bibliography requires an extra pass: xelatex -> biber/bibtex -> xelatex.
  const hasBib = document.getText().includes("\\bibliography{") ||
    document.getText().includes("\\addbibresource{");
  if (hasBib) {
    const biber = await findBinary("biber");
    const bibtex = await findBinary("bibtex");
    const bibTool = biber || bibtex;
    if (bibTool) {
      try {
        await exec(bibTool, [path.join(cacheDir, baseName)], {
          cwd: cacheDir,
          timeout: 30_000,
          env: texEnv,
        });
      } catch (err: any) {
        if (err.stderr) stderr += "\n" + err.stderr;
      }
      try {
        const result = await exec(xelatex, args, {
          cwd: sourceDir,
          timeout: 120_000,
          env: texEnv,
        });
        stdout = result.stdout;
        stderr += "\n" + result.stderr;
      } catch (err: any) {
        if (err.stderr) stderr += "\n" + err.stderr;
        if (err.stdout) stdout = err.stdout;
      }
    }
  }

  const tmpOutput = path.join(cacheDir, `${baseName}.pdf`);
  const pdfExists = fs.existsSync(tmpOutput);

  if (pdfExists) {
    fs.copyFileSync(tmpOutput, pdfOutput);
  }

  const logFile = path.join(cacheDir, `${baseName}.log`);
  let logContent = "";
  try {
    logContent = fs.readFileSync(logFile, "utf-8");
  } catch {}

  const combined = stderr + "\n" + stdout + "\n" + logContent;
  const errors = parseErrors(stderr + "\n" + logContent, stdout);
  const duration = (Date.now() - start) / 1000;

  return {
    success: pdfExists,
    pdfPath: pdfExists ? pdfOutput : undefined,
    errors,
    log: combined,
    duration,
  };
}

const COPY_EXTS = new Set([
  ".cls", ".sty", ".bst", ".bib", ".def", ".fd", ".cfg", ".clo",
  ".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg",
  ".ttf", ".otf",
]);

const RESOURCE_SUBDIRS = ["references", "figures", "images", "assets"];

function copySiblingFiles(sourceDir: string, cacheDir: string): void {
  copyDirFiles(sourceDir, cacheDir);
  for (const sub of RESOURCE_SUBDIRS) {
    const subSrc = path.join(sourceDir, sub);
    if (fs.existsSync(subSrc) && fs.statSync(subSrc).isDirectory()) {
      const subDst = path.join(cacheDir, sub);
      fs.mkdirSync(subDst, { recursive: true });
      copyDirFiles(subSrc, subDst);
    }
    const inkwellSub = path.join(sourceDir, ".inkwell", sub);
    if (fs.existsSync(inkwellSub) && fs.statSync(inkwellSub).isDirectory()) {
      const subDst = path.join(cacheDir, ".inkwell", sub);
      fs.mkdirSync(subDst, { recursive: true });
      copyDirFiles(inkwellSub, subDst);
    }
  }
}

function copyDirFiles(srcDir: string, dstDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(srcDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (COPY_EXTS.has(ext)) {
      try {
        const src = path.join(srcDir, entry);
        const dst = path.join(dstDir, entry);
        if (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) {
          fs.copyFileSync(src, dst);
        }
      } catch {}
    }
  }
}

function checkTemplateFeatures(
  sourceText: string,
  activeTemplate: ResolvedTemplate,
  documentUri: vscode.Uri
): { warnings: CompileError[]; logLines: string[] } {
  const warnings: CompileError[] = [];
  const logLines: string[] = [];
  const allFeatures = collectAllFeatures(documentUri);

  for (const { templateId, templateName, feature } of allFeatures) {
    let regex: RegExp;
    try {
      regex = new RegExp(feature.pattern, "m");
    } catch {
      continue;
    }
    const match = sourceText.match(regex);
    if (!match) continue;

    if (templateId === activeTemplate.id) {
      logLines.push(`[inkwell] feature: ${feature.syntax} (${feature.description})`);
    } else {
      const idx = match.index || 0;
      const line = sourceText.substring(0, idx).split("\n").length;
      warnings.push({
        line,
        message: `${feature.syntax} requires the "${templateName}" template (current: "${activeTemplate.manifest.name}")`,
        severity: "warning",
      });
      logLines.push(`[inkwell] WARNING line ${line}: ${feature.syntax} requires "${templateName}" template`);
    }
  }

  return { warnings, logLines };
}

async function compilePandoc(
  document: vscode.TextDocument,
  outputPath?: string
): Promise<CompileResult> {
  const start = Date.now();
  const sourceFile = document.uri.fsPath;
  const sourceDir = path.dirname(sourceFile);
  const baseName = path.basename(sourceFile, path.extname(sourceFile));

  const pandoc = await findBinary("pandoc");
  if (!pandoc) {
    return {
      success: false,
      pdfPath: undefined,
      errors: [
        { line: undefined, message: "pandoc not found", severity: "error" },
      ],
      log: "",
      duration: 0,
    };
  }

  const cacheDir = getCacheDir(sourceFile);
  const pdfOutput = outputPath || path.join(sourceDir, `${baseName}.pdf`);
  purgeCompileArtifacts(cacheDir, baseName);
  try { fs.unlinkSync(pdfOutput); } catch {}

  const template = getTemplateForDocument(document);
  const templateName = path.basename(template.pandocTemplate);
  const templateDst = path.join(cacheDir, templateName);
  fs.copyFileSync(template.pandocTemplate, templateDst);
  copySupportingFiles(template, cacheDir);

  const preferredEngine: PdfEngine = template.manifest.engine || "xelatex";
  const engine = await findBinary(preferredEngine) || await findBinary("xelatex");
  if (!engine) {
    return {
      success: false,
      pdfPath: undefined,
      errors: [{ line: undefined, message: `PDF engine not found (tried ${preferredEngine}, xelatex)`, severity: "error" }],
      log: "",
      duration: (Date.now() - start) / 1000,
    };
  }

  const rawText = document.getText();
  const featureCheck = checkTemplateFeatures(rawText, template, document.uri);
  const { injected } = prepareForCompilation(rawText, sourceFile);

  const tmpSource = path.join(cacheDir, path.basename(sourceFile));
  fs.writeFileSync(tmpSource, injected, "utf-8");

  const tmpOutput = path.join(cacheDir, `${baseName}.pdf`);

  const ext = path.extname(sourceFile).toLowerCase();
  let fromFormat = `markdown+${PANDOC_EXTENSIONS}`;
  if (ext === ".rst") fromFormat = "rst";
  else if (ext === ".org") fromFormat = "org";
  else if (ext === ".txt") fromFormat = `markdown+${PANDOC_EXTENSIONS}`;

  const resourcePath = [cacheDir, template.dir, sourceDir].join(":");

  const args = [
    tmpSource,
    "-o",
    tmpOutput,
    `--pdf-engine=${engine}`,
    "--standalone",
    `--template=${templateDst}`,
    `--from=${fromFormat}`,
    `--resource-path=${resourcePath}`,
    "-V",
    "graphics=true",
    "-V",
    "colorlinks=true",
    "-V",
    "numbersections=true",
    "--citeproc",
  ];

  const preambleFile = writePreambleFile(rawText, cacheDir);
  if (preambleFile) {
    args.push("-H", preambleFile);
  }

  const crossref = await findBinary("pandoc-crossref");
  if (crossref) {
    args.splice(args.indexOf("--citeproc"), 0, "--filter", crossref);
  }

  const projectRoot = findInkwellRoot(document.uri);
  if (projectRoot) {
    const bibFiles = findBibFiles(projectRoot);
    for (const bib of bibFiles) {
      args.push("--bibliography", bib);
    }
    const defaults = findDefaultsYaml(projectRoot);
    if (defaults) {
      args.push("--defaults", defaults);
    }
  }

  copySiblingFiles(sourceDir, cacheDir);

  let stderr = "";
  let stdout = "";

  // TEXINPUTS lets the TeX engine find .cls, .sty, and other supporting
  // files that live in the cache dir, the template's own directory (for
  // subdirectory-structured classes like rmaa-rho-class/), or beside
  // the source document. The trailing colon preserves default TeX paths.
  const texInputs = [cacheDir, template.dir, sourceDir, ""].join(":");
  const texEnv = {
    ...TEX_ENV,
    TEXINPUTS: texInputs,
  };

  const clsExpected = path.join(template.dir, "rmaa-rho-class", "rmaa-rho.cls");
  const clsCached = path.join(cacheDir, "rmaa-rho-class", "rmaa-rho.cls");
  const cacheBib = path.join(cacheDir, "references", "refs.bib");
  const diagnosticLog = [
    `[inkwell] template: ${template.id} (${template.dir})`,
    `[inkwell] pandoc template: ${templateDst}`,
    `[inkwell] TEXINPUTS: ${texInputs}`,
    `[inkwell] resource-path: ${resourcePath}`,
    `[inkwell] cls in template dir: ${fs.existsSync(clsExpected)}`,
    `[inkwell] cls in cache dir: ${fs.existsSync(clsCached)}`,
    `[inkwell] engine: ${engine}`,
    `[inkwell] pandoc args: ${args.join(" ")}`,
    `[inkwell] cache bib exists: ${fs.existsSync(cacheBib)}`,
    `[inkwell] cache dir contents: ${(() => { try { return fs.readdirSync(cacheDir).join(", "); } catch { return "error"; } })()}`,
    ...featureCheck.logLines,
  ].join("\n");

  try {
    const result = await exec(pandoc, args, {
      cwd: sourceDir,
      timeout: 120_000,
      env: texEnv,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    if (err.stderr) stderr = err.stderr;
    if (err.stdout) stdout = err.stdout;
  }

  const pdfExists = fs.existsSync(tmpOutput);
  if (pdfExists) {
    fs.copyFileSync(tmpOutput, pdfOutput);
  }

  const errors = [...featureCheck.warnings, ...parseErrors(stderr, stdout)];
  const duration = (Date.now() - start) / 1000;

  return {
    success: pdfExists,
    pdfPath: pdfExists ? pdfOutput : undefined,
    errors,
    log: diagnosticLog + "\n\n" + stderr + "\n" + stdout,
    duration,
  };
}

export async function exportPDF(
  document: vscode.TextDocument,
  diagnostics: InkwellDiagnostics
): Promise<void> {
  const baseName = path.basename(
    document.uri.fsPath,
    path.extname(document.uri.fsPath)
  );

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(path.dirname(document.uri.fsPath), `${baseName}.pdf`)
    ),
    filters: { PDF: ["pdf"] },
  });

  if (!target) return;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Compiling PDF..." },
    () => compile(document, target.fsPath)
  );

  diagnostics.report(document.uri, result.errors);

  if (result.success) {
    vscode.window.showInformationMessage(`PDF saved to ${target.fsPath}`);
  } else {
    vscode.window.showErrorMessage("PDF compilation failed.");
  }
}

function parseErrors(stderr: string, stdout: string): CompileError[] {
  const combined = stderr + "\n" + stdout;
  const errors: CompileError[] = [];
  const lines = combined.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const missing = parseMissingPackage(line);
    if (missing) {
      errors.push(missing);
      continue;
    }

    const pandocErr = parsePandocError(line);
    if (pandocErr) {
      errors.push(pandocErr);
      continue;
    }

    const latexErr = parseLatexError(line, lines, i);
    if (latexErr) {
      errors.push(latexErr);
      continue;
    }

    const warning = parseLatexWarning(line, lines, i);
    if (warning) {
      errors.push(warning);
    }
  }

  return errors;
}

function parsePandocError(line: string): CompileError | undefined {
  const match = line.match(/\.md:(\d+):\d+:?\s*(.+)/);
  if (!match) return undefined;
  return {
    line: parseInt(match[1], 10),
    message: match[2].trim(),
    severity: "error",
  };
}

function parseLatexError(
  line: string,
  context: string[],
  index: number
): CompileError | undefined {
  if (!line.startsWith("!")) return undefined;
  const msg = line.slice(1).trim();

  let lineNum: number | undefined;
  const end = Math.min(index + 5, context.length);
  for (let j = index; j < end; j++) {
    if (context[j].startsWith("l.")) {
      const numStr = context[j].slice(2).match(/^\d+/);
      if (numStr) lineNum = parseInt(numStr[0], 10);
      break;
    }
  }

  return { line: lineNum, message: msg, severity: "error" };
}

function parseLatexWarning(
  line: string,
  context: string[],
  index: number
): CompileError | undefined {
  const trimmed = line.trim();

  if (trimmed.startsWith("Overfull") || trimmed.startsWith("Underfull")) {
    return {
      line: extractWarningLineNumber(trimmed),
      message: trimmed,
      severity: "warning",
    };
  }

  if (
    trimmed.startsWith("LaTeX Warning:") ||
    (trimmed.startsWith("Package") && trimmed.includes("Warning:"))
  ) {
    let msg = trimmed;
    let j = index + 1;
    while (j < context.length) {
      const next = context[j].trim();
      if (
        !next ||
        next.startsWith("!") ||
        next.startsWith("Overfull") ||
        next.startsWith("Underfull")
      )
        break;
      if (context[j].startsWith(" ") || context[j].startsWith("(")) {
        msg += " " + next;
        j++;
      } else {
        break;
      }
    }
    return {
      line: extractWarningLineNumber(msg),
      message: msg,
      severity: "warning",
    };
  }

  return undefined;
}

function extractWarningLineNumber(text: string): number | undefined {
  const patterns = [/at lines?\s+(\d+)/, /on input line\s+(\d+)/];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function parseMissingPackage(line: string): CompileError | undefined {
  const patterns = [
    /File [`']([^'`]+\.sty)[`'] not found/,
    /Encoding file [`']([^'`]+)[`'] not found/,
    /file ['`]([^'`]+\.sty)['`'] not found/i,
  ];
  for (const pat of patterns) {
    const m = line.match(pat);
    if (m) {
      const filename = m[1];
      const packageName = filename.replace(".sty", "");
      return {
        line: undefined,
        message: `Missing file: ${filename}`,
        severity: "error",
        missingPackage: packageName,
      };
    }
  }
  return undefined;
}
