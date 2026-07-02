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
import { findBibFiles, findDefaultsYaml, getInkwellProjectRoot } from "./config";
import { splitFrontmatter } from "./frontmatter";
import { InkwellDiagnostics, CompileError } from "./diagnostics";
import { getTemplateForDocument, copySupportingFiles, PdfEngine, ResolvedTemplate, collectAllFeatures } from "./templates";
import { prepareForCompilation } from "./inject";
import { writePreambleFile } from "./preamble";
import { buildTexInvocationPath, texBinSearchDirs } from "./shell-env";
import { tlmgrPackageForFile } from "./toolchain";
import { getInkwellOutputChannel } from "./inkwell-output";

const exec = promisify(execFile);

// Mirrored in scripts/compile-demo.sh (PANDOC_EXTS). check-template-regressions.mjs
// fails the build if the two lists drift.
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

const TEX_ENV = {
  ...process.env,
  PATH: buildTexInvocationPath(),
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

  for (const dir of texBinSearchDirs()) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      binaryCache.set(name, { result: candidate, ts: Date.now() });
      return candidate;
    }
  }
  // Fall back to the OS resolver, but with the augmented TeX PATH so a
  // GUI-launched editor (minimal launchd PATH) still resolves tools that
  // the toolchain probe found. Without TEX_ENV here, "Check Toolchain"
  // could report ready while compile fails with "binary not found".
  try {
    const { stdout } = await exec("which", [name], { env: TEX_ENV });
    const trimmed = stdout.trim();
    if (trimmed) {
      binaryCache.set(name, { result: trimmed, ts: Date.now() });
      return trimmed;
    }
  } catch {}
  return undefined;
}

// Compile serialization has three intentional layers, each at a distinct
// entry point:
//   1. This per-(document,output) lock coalesces identical concurrent
//      compile() calls into one promise (e.g. preview button + onSave for
//      the same file fire only one compile).
//   2. extension.runCompile adds single-flight + latest-wins across the
//      command / onSave / interval-timer triggers, so two *different*
//      documents never compile concurrently.
//   3. preview.handleCompile does the same for the webview compile button.
// They are not redundant: the lock here only dedupes identical keys, while
// the caller-side queues serialize distinct documents.
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

  const projectRoot = getInkwellProjectRoot(sourceFile);
  copySiblingFiles(sourceDir, projectRoot, cacheDir);
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
      // Two passes after the bib tool: the first pulls in the .bbl, the
      // second resolves the now-defined \cite labels and page references.
      for (let pass = 0; pass < 2; pass++) {
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

function copySiblingFiles(sourceDir: string, projectRoot: string, cacheDir: string): void {
  copyDirFiles(sourceDir, cacheDir);
  const roots = [sourceDir];
  if (projectRoot !== sourceDir) roots.push(projectRoot);
  for (const root of roots) {
    for (const sub of RESOURCE_SUBDIRS) {
      const subSrc = path.join(root, sub);
      if (fs.existsSync(subSrc) && fs.statSync(subSrc).isDirectory()) {
        const subDst = path.join(cacheDir, sub);
        fs.mkdirSync(subDst, { recursive: true });
        copyDirFiles(subSrc, subDst);
      }
      const inkwellSub = path.join(root, ".inkwell", sub);
      if (fs.existsSync(inkwellSub) && fs.statSync(inkwellSub).isDirectory()) {
        const subDst = path.join(cacheDir, ".inkwell", sub);
        fs.mkdirSync(subDst, { recursive: true });
        copyDirFiles(inkwellSub, subDst);
      }
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

  // The manifest engine is a hard requirement, never a preference.
  // pdflatex-only templates (tufte, rho, rmxaa, tmsce, eth-report,
  // kth-letter) use inputenc/fontenc and break under XeLaTeX, while the
  // default template needs fontspec and breaks under pdfLaTeX. Silently
  // substituting one for the other produces cryptic LaTeX errors deep in
  // the log instead of an actionable message here.
  const requiredEngine: PdfEngine = template.manifest.engine || "xelatex";
  const engine = await findBinary(requiredEngine);
  if (!engine) {
    return {
      success: false,
      pdfPath: undefined,
      errors: [{
        line: undefined,
        message: `The "${template.manifest.name}" template requires ${requiredEngine}, which is not installed. ` +
          `Run "Inkwell: Check / Install Toolchain (Pandoc, XeLaTeX)" to install it.`,
        severity: "error",
      }],
      log: `[inkwell] template "${template.id}" requires PDF engine "${requiredEngine}" (from template.json), but no ${requiredEngine} binary was found on PATH or in known TeX locations.`,
      duration: (Date.now() - start) / 1000,
    };
  }

  const rawText = document.getText();
  const featureCheck = checkTemplateFeatures(rawText, template, document.uri);
  const { injected } = prepareForCompilation(rawText, sourceFile);

  const tmpSource = path.join(cacheDir, path.basename(sourceFile));
  fs.writeFileSync(tmpSource, injected, "utf-8");

  // Two-stage compile:
  //   1. pandoc  ->  .tex  (runs the template, pandoc-crossref, citeproc)
  //   2. engine  ->  .pdf  (run twice so \ref / \pageref / \tableofcontents
  //                         and pandoc-crossref's internal refs resolve)
  // The single-pass `pandoc --pdf-engine=...` flow only ran the engine
  // once, which produced ? marks and \pageref{LastPage} showing as
  // "??" on every first compile. Two passes is the documented minimum
  // for LaTeX cross-reference resolution.
  const tmpTex = path.join(cacheDir, `${baseName}.tex`);
  const tmpOutput = path.join(cacheDir, `${baseName}.pdf`);

  const ext = path.extname(sourceFile).toLowerCase();
  let fromFormat = `markdown+${PANDOC_EXTENSIONS}`;
  if (ext === ".rst") fromFormat = "rst";
  else if (ext === ".org") fromFormat = "org";
  else if (ext === ".txt") fromFormat = `markdown+${PANDOC_EXTENSIONS}`;

  const projectRoot = getInkwellProjectRoot(sourceFile);
  const resourcePath = [cacheDir, template.dir, sourceDir, projectRoot].join(":");

  const pandocArgs = [
    tmpSource,
    "-o",
    tmpTex,
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

  // `top-level-division` is a Pandoc *option*, not a template variable, so
  // a frontmatter `top-level-division: chapter` is silently ignored unless
  // forwarded as a CLI flag. Book/report templates (tufte-book-vdqi) need
  // it for `#` headings to become \chapter instead of \section.
  const division = extractTopLevelDivision(rawText);
  if (division) {
    pandocArgs.push(`--top-level-division=${division}`);
  }

  const preambleFile = writePreambleFile(rawText, cacheDir);
  if (preambleFile) {
    pandocArgs.push("-H", preambleFile);
  }

  const crossref = await findBinary("pandoc-crossref");
  if (crossref) {
    const citeprocIndex = pandocArgs.indexOf("--citeproc");
    if (citeprocIndex >= 0) {
      pandocArgs.splice(citeprocIndex, 0, "--filter", crossref);
    } else {
      pandocArgs.push("--filter", crossref);
    }
  }

  const bibFiles = findBibFiles(projectRoot);
  for (const bib of bibFiles) {
    pandocArgs.push("--bibliography", bib);
  }
  const defaults = findDefaultsYaml(projectRoot);
  if (defaults) {
    pandocArgs.push("--defaults", defaults);
  }

  copySiblingFiles(sourceDir, projectRoot, cacheDir);

  let stderr = "";
  let stdout = "";

  // TEXINPUTS lets the TeX engine find .cls, .sty, and other supporting
  // files that live in the cache dir, the template's own directory (for
  // subdirectory-structured classes like rmaa-rho-class/), or beside
  // the source document. The trailing colon preserves default TeX paths.
  const texInputs = [cacheDir, template.dir, sourceDir, projectRoot, ""].join(":");
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
    `[inkwell] pandoc argv: ${pandoc} ${pandocArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
    `[inkwell] cache bib exists: ${fs.existsSync(cacheBib)}`,
    `[inkwell] cache dir contents: ${(() => { try { return fs.readdirSync(cacheDir).join(", "); } catch { return "error"; } })()}`,
    ...featureCheck.logLines,
  ].join("\n");

  // Stage 1: pandoc -> .tex
  try {
    const result = await exec(pandoc, pandocArgs, {
      cwd: sourceDir,
      timeout: 60_000,
      env: texEnv,
    });
    stdout += result.stdout;
    stderr += result.stderr;
  } catch (err: any) {
    if (err.stderr) stderr += err.stderr;
    if (err.stdout) stdout += err.stdout;
  }

  const texExists = fs.existsSync(tmpTex);
  let logContent = "";

  // Stage 2: engine -> .pdf, run twice to resolve cross-references.
  // Skip if pandoc failed to produce the .tex.
  if (texExists) {
    const engineArgs = [
      "-interaction=nonstopmode",
      "-halt-on-error",
      `-output-directory=${cacheDir}`,
      tmpTex,
    ];

    for (let pass = 0; pass < 2; pass++) {
      stdout += `\n[inkwell] ${engine} pass ${pass + 1}: ${engine} ${engineArgs.join(" ")}\n`;
      try {
        const result = await exec(engine, engineArgs, {
          cwd: sourceDir,
          timeout: 90_000,
          env: texEnv,
        });
        stdout += result.stdout;
        stderr += result.stderr;
      } catch (err: any) {
        if (err.stdout) stdout += err.stdout;
        if (err.stderr) stderr += err.stderr;
        // First-pass failures are expected (undefined refs, missing
        // aux entries). Continue to pass 2 in that case; it typically
        // resolves. Only a pass-2 failure is a real compile error.
        if (pass === 0) continue;
      }
    }

    // Bibliography handling for the raw-\cite path. Pandoc's
    // --citeproc inlines CSL entries directly, so in the typical
    // Inkwell flow we have no \bibliography / \addbibresource in
    // the generated .tex and biber/bibtex are unneeded. A user with
    // raw LaTeX \cite commands still gets served: we detect the
    // macro in the generated .tex and run biber/bibtex + one more
    // engine pass in that case.
    try {
      const texContent = fs.readFileSync(tmpTex, "utf-8");
      const hasBib = /\\(bibliography|addbibresource)\{/.test(texContent);
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
          // Two passes after the bib tool so the .bbl is pulled in and the
          // resulting \cite / page references resolve in the same compile.
          for (let pass = 0; pass < 2; pass++) {
            try {
              const r = await exec(engine, engineArgs, {
                cwd: sourceDir,
                timeout: 90_000,
                env: texEnv,
              });
              stdout += r.stdout;
              stderr += r.stderr;
            } catch (err: any) {
              if (err.stderr) stderr += err.stderr;
              if (err.stdout) stdout += err.stdout;
            }
          }
        }
      }
    } catch {}

    const logFile = path.join(cacheDir, `${baseName}.log`);
    try {
      logContent = fs.readFileSync(logFile, "utf-8");
    } catch {}
  }

  const pdfExists = fs.existsSync(tmpOutput);
  if (pdfExists) {
    fs.copyFileSync(tmpOutput, pdfOutput);
  }

  const errors = [
    ...featureCheck.warnings,
    ...parseErrors(stderr + "\n" + logContent, stdout, { generatedTex: true }),
  ];
  const duration = (Date.now() - start) / 1000;

  const logFile = path.join(cacheDir, `${baseName}.log`);
  return {
    success: pdfExists,
    pdfPath: pdfExists ? pdfOutput : undefined,
    errors,
    log: diagnosticLog +
      `\n[inkwell] full engine log: ${logFile}` +
      "\n\n" + stderr + "\n" + stdout +
      (logContent ? "\n\n--- engine log (excerpt) ---\n" + extractEngineLogExcerpt(logContent) : ""),
    duration,
  };
}

/**
 * Frontmatter `top-level-division: chapter|part|section`, validated so a
 * typo can't inject an arbitrary CLI argument into the pandoc invocation.
 */
function extractTopLevelDivision(text: string): string | undefined {
  const fm = splitFrontmatter(text);
  if (!fm) return undefined;
  const m = fm.fm.match(/^top-level-division:\s*['"]?(chapter|part|section)['"]?\s*(?:#.*)?$/m);
  return m ? m[1] : undefined;
}

/**
 * TeX writes its fatal error near the first "!" line, often early in a
 * long log; the old tail-slice routinely cut it off, leaving the
 * visible log without the actual failure. Show the first error block
 * (with leading context) plus the tail summary instead.
 */
function extractEngineLogExcerpt(logContent: string): string {
  const MAX = 12_000;
  if (logContent.length <= MAX) return logContent;

  const lines = logContent.split("\n");
  const firstError = lines.findIndex((l) => l.startsWith("!"));
  if (firstError === -1) return logContent.slice(-8000);

  const from = Math.max(0, firstError - 10);
  const errorBlock = lines.slice(from, firstError + 120).join("\n");
  const tail = logContent.slice(-2000);
  return errorBlock + "\n\n[... log truncated; full log path is listed above ...]\n\n" + tail;
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
    await reportCompileFailure(document, result);
  }
}

/**
 * Shared failure UX for non-preview compiles: write the full log to the
 * "Inkwell LaTeX" output channel and show a notification that names the
 * first real error, with actions to open the log or fix the toolchain.
 */
export async function reportCompileFailure(
  document: vscode.TextDocument,
  result: CompileResult
): Promise<void> {
  const channel = getInkwellOutputChannel();
  channel.appendLine(`\n=== Compile failed: ${path.basename(document.uri.fsPath)} (${new Date().toLocaleTimeString()}) ===`);
  channel.appendLine(result.log || "(no log output)");

  const firstError = result.errors.find((e) => e.severity === "error");
  const summary = firstError
    ? firstError.message
    : "Compilation failed — see the log for details.";

  const toolchainProblem = /not (found|installed)/i.test(summary) || firstError?.missingPackage;
  const actions = toolchainProblem ? ["Show Log", "Check Toolchain"] : ["Show Log"];

  const choice = await vscode.window.showErrorMessage(`Inkwell: ${summary}`, ...actions);
  if (choice === "Show Log") {
    channel.show(true);
  } else if (choice === "Check Toolchain") {
    vscode.commands.executeCommand("inkwell.setupToolchain");
  }
}

export interface ParseOptions {
  /**
   * True when the LaTeX engine compiled a *generated* .tex file (the
   * Pandoc pipeline). Engine line numbers then refer to the generated
   * LaTeX, not the markdown the user is editing, so attaching them to
   * editor diagnostics would underline unrelated lines. We fold the
   * number into the message text instead.
   */
  generatedTex: boolean;
}

// Exported for scripts/check-error-parsing.mjs.
export function parseErrors(
  stderr: string,
  stdout: string,
  opts: ParseOptions = { generatedTex: false }
): CompileError[] {
  const combined = stderr + "\n" + stdout;
  const errors: CompileError[] = [];
  const lines = combined.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const err =
      parseMissingFile(line) ||
      parsePandocDiagnostic(line) ||
      parseLatexError(line, lines, i, opts) ||
      parseLatexWarning(line, lines, i, opts);
    if (err) errors.push(err);
  }

  return dedupeErrors(errors);
}

/** Drop repeats: multi-pass compiles emit identical errors per pass. */
function dedupeErrors(errors: CompileError[]): CompileError[] {
  const seen = new Set<string>();
  const out: CompileError[] = [];
  for (const e of errors) {
    const key = `${e.severity}::${e.line ?? ""}::${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

const IMAGE_EXTS = /\.(png|jpe?g|pdf|eps|svg|gif|tiff?)$/i;
const TEX_PACKAGE_EXTS = /\.(sty|cls|ldf|def|fd|clo|bst|cfg)$/i;

/**
 * "File `X' not found" covers several distinct user problems. Classify
 * by extension so each gets guidance pointing at the actual fix.
 */
function parseMissingFile(line: string): CompileError | undefined {
  const patterns = [
    /[Ff]ile [`']([^'`]+)[`'] not found/,
    /Encoding file [`']([^'`]+)[`'] not found/,
    /Unable to load picture or PDF file [`']([^'`]+)[`']/,
  ];
  let filename: string | undefined;
  for (const pat of patterns) {
    const m = line.match(pat);
    if (m) {
      filename = m[1];
      break;
    }
  }
  if (!filename) return undefined;

  if (TEX_PACKAGE_EXTS.test(filename)) {
    const pkg = tlmgrPackageForFile(filename);
    const what = filename.endsWith(".cls") ? "document class" : "LaTeX package";
    return {
      line: undefined,
      message: `Missing ${what}: ${filename} is not installed. Install the "${pkg}" package via tlmgr (quick fix available), or run "Inkwell: Check / Install Toolchain" to install everything at once.`,
      severity: "error",
      missingPackage: pkg,
    };
  }

  if (IMAGE_EXTS.test(filename)) {
    return {
      line: undefined,
      message: `Image not found: ${filename}. Check the path — it is resolved relative to the document, the project root, and .inkwell/figures. If the image comes from a code block, run the code blocks first (Inkwell: Run Code Blocks).`,
      severity: "error",
    };
  }

  if (filename.endsWith(".bib")) {
    return {
      line: undefined,
      message: `Bibliography file not found: ${filename}. Set "bibliography:" in the YAML frontmatter or place a .bib file in the project root, references/, or .inkwell/references/.`,
      severity: "error",
    };
  }

  return {
    line: undefined,
    message: `File not found during compilation: ${filename}`,
    severity: "error",
  };
}

/** Errors and warnings emitted by Pandoc itself (stage 1). */
function parsePandocDiagnostic(line: string): CompileError | undefined {
  const positioned = line.match(/\.md:(\d+):\d+:?\s*(.+)/);
  if (positioned) {
    return {
      line: parseInt(positioned[1], 10),
      message: positioned[2].trim(),
      severity: "error",
    };
  }

  // Pandoc 3.x: "[WARNING] Citeproc: citation X not found". Older
  // formats kept for pandoc 2.x installs.
  const citation = line.match(/Citeproc: citation ([^\s]+) not found/i)
    || line.match(/\[WARNING\] Citation '([^']+)' not found/i)
    || line.match(/citeproc: reference ([^\s]+) not found/i);
  if (citation) {
    return {
      line: undefined,
      message: `Citation @${citation[1]} not found in the bibliography. Add the entry to your .bib file or fix the citation key.`,
      severity: "warning",
    };
  }

  const resource = line.match(/Could not fetch resource '?([^'\s]+?)'?:?(?:\s|$)/i);
  if (resource) {
    return {
      line: undefined,
      message: `Pandoc could not find "${resource[1]}". Check the path relative to the document or project root.`,
      severity: "error",
    };
  }

  const missingInput = line.match(/pandoc: ([^:]+): openBinaryFile: does not exist/);
  if (missingInput) {
    const f = missingInput[1].trim();
    const hint = f.endsWith(".bib")
      ? ' Set "bibliography:" in the frontmatter or place the file in .inkwell/references/.'
      : "";
    return {
      line: undefined,
      message: `File does not exist: ${f}.${hint}`,
      severity: "error",
    };
  }

  if (/YAML parse exception/i.test(line)) {
    return {
      line: undefined,
      message: `Invalid YAML frontmatter: ${line.replace(/.*YAML parse exception/i, "YAML parse exception").trim()}. Check indentation and quoting in the metadata block at the top of the document.`,
      severity: "error",
    };
  }

  return undefined;
}

/**
 * Rewrites raw TeX errors into messages that say what to do about
 * them. Anything unrecognized passes through verbatim.
 */
function enrichLatexMessage(
  msg: string,
  context: string[],
  index: number
): string {
  if (msg.startsWith("Undefined control sequence")) {
    // The offending macro is the tail of the "l.<n> ..." context line.
    const end = Math.min(index + 6, context.length);
    for (let j = index; j < end; j++) {
      const m = context[j].match(/^l\.\d+.*?(\\[a-zA-Z@]+)\s*$/);
      if (m) {
        return `Undefined control sequence ${m[1]} — either a typo, or it needs a package/template that is not loaded.`;
      }
    }
    return "Undefined control sequence — a LaTeX command is used that no loaded package defines. See the compile log for the exact macro.";
  }

  if (msg.includes("fontspec") && /[Ff]ont/.test(msg)) {
    // fontspec wraps its messages; the font name may be on a
    // continuation line prefixed with "(fontspec)".
    let fontName = msg.match(/"([^"]+)"/)?.[1];
    if (!fontName) {
      const end = Math.min(index + 6, context.length);
      for (let j = index + 1; j < end; j++) {
        const m = context[j].match(/"([^"]+)"/);
        if (m) {
          fontName = m[1];
          break;
        }
      }
    }
    const which = fontName ? `"${fontName}"` : "requested by the template or frontmatter";
    return `Font ${which} is not installed on this system. Install the font, or change mainfont/sansfont/monofont in the YAML frontmatter.`;
  }

  if (msg.includes("inputenc Error") && msg.includes("Unicode")) {
    return `${msg} — this template compiles with pdfLaTeX, which cannot typeset this Unicode character. Replace the character, or switch to a XeLaTeX-based template (e.g. the default "inkwell" template).`;
  }

  if (msg.startsWith("Emergency stop") || msg.startsWith("Fatal error occurred")) {
    return "LaTeX stopped before producing a PDF — usually caused by an earlier error above (missing file or package). See the compile log.";
  }

  return msg;
}

function parseLatexError(
  line: string,
  context: string[],
  index: number,
  opts: ParseOptions
): CompileError | undefined {
  if (!line.startsWith("!")) return undefined;
  const msg = enrichLatexMessage(line.slice(1).trim(), context, index);

  let lineNum: number | undefined;
  const end = Math.min(index + 5, context.length);
  for (let j = index; j < end; j++) {
    if (context[j].startsWith("l.")) {
      const numStr = context[j].slice(2).match(/^\d+/);
      if (numStr) lineNum = parseInt(numStr[0], 10);
      break;
    }
  }

  if (opts.generatedTex && lineNum !== undefined) {
    return {
      line: undefined,
      message: `${msg} (at line ${lineNum} of the generated LaTeX, not your markdown — see the compile log)`,
      severity: "error",
    };
  }

  return { line: lineNum, message: msg, severity: "error" };
}

function parseLatexWarning(
  line: string,
  context: string[],
  index: number,
  opts: ParseOptions
): CompileError | undefined {
  const trimmed = line.trim();

  if (trimmed.startsWith("Overfull") || trimmed.startsWith("Underfull")) {
    return {
      line: opts.generatedTex ? undefined : extractWarningLineNumber(trimmed),
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
      line: opts.generatedTex ? undefined : extractWarningLineNumber(msg),
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
