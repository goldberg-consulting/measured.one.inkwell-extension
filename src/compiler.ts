import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { findInkwellRoot, findBibFiles, findDefaultsYaml } from "./config";
import { InkwellDiagnostics, CompileError } from "./diagnostics";
import { getTemplateForDocument, copySupportingFiles } from "./templates";
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

function buildTexPath(): string {
  const base = ["/usr/local/bin", "/usr/bin"];
  if (process.platform === "darwin") {
    return ["/Library/TeX/texbin", "/opt/homebrew/bin", ...base, process.env.PATH].join(":");
  }
  const home = os.homedir();
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

function installTemplate(
  document: vscode.TextDocument,
  cacheDir: string
): string {
  const template = getTemplateForDocument(document);
  const templateName = path.basename(template.pandocTemplate);
  const templateDst = path.join(cacheDir, templateName);
  fs.copyFileSync(template.pandocTemplate, templateDst);
  copySupportingFiles(template, cacheDir);
  return templateDst;
}

function getCacheDir(sourceFile: string): string {
  const hash = Buffer.from(sourceFile).toString("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "inkwell-vscode", hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function findBinary(name: string): Promise<string | undefined> {
  const common = [`/usr/local/bin/${name}`, `/usr/bin/${name}`];
  const home = os.homedir();
  const platformPaths = process.platform === "darwin"
    ? [`/opt/homebrew/bin/${name}`, `/Library/TeX/texbin/${name}`, ...common]
    : [
        ...common,
        `${home}/.TinyTeX/bin/x86_64-linux/${name}`,
        `${home}/.TinyTeX/bin/aarch64-linux/${name}`,
      ];

  for (const p of platformPaths) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { stdout } = await exec("which", [name]);
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch {}
  return undefined;
}

export async function compile(
  document: vscode.TextDocument,
  outputPath?: string
): Promise<CompileResult> {
  const mode = detectMode(document);
  if (mode === "xelatex") {
    return compileTeX(document, outputPath);
  }
  return compilePandoc(document, outputPath);
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

  const tmpSource = path.join(cacheDir, path.basename(sourceFile));
  fs.writeFileSync(tmpSource, document.getText(), "utf-8");

  // Copy supporting files from the source directory (.cls, .sty, .bst, images)
  copySiblingFiles(sourceDir, cacheDir);

  // Also copy template supporting files if an inkwell template is selected
  const template = getTemplateForDocument(document);
  copySupportingFiles(template, cacheDir);

  const args = [
    "-interaction=nonstopmode",
    "-halt-on-error",
    `-output-directory=${cacheDir}`,
    tmpSource,
  ];

  let stderr = "";
  let stdout = "";

  // XeLaTeX needs two passes for references/TOC
  for (let pass = 0; pass < 2; pass++) {
    try {
      const result = await exec(xelatex, args, {
        cwd: sourceDir,
        timeout: 120_000,
        env: TEX_ENV,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: any) {
      if (err.stdout) stdout = err.stdout;
      if (err.stderr) stderr = err.stderr;
      if (pass === 0) break;
    }
  }

  // Check for bibtex/biber if .bib files referenced
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
          env: TEX_ENV,
        });
        // Third pass after bibliography
        try {
          await exec(xelatex, args, {
            cwd: sourceDir,
            timeout: 120_000,
            env: TEX_ENV,
          });
        } catch {}
      } catch {}
    }
  }

  const tmpOutput = path.join(cacheDir, `${baseName}.pdf`);
  const pdfOutput = outputPath || path.join(sourceDir, `${baseName}.pdf`);
  const pdfExists = fs.existsSync(tmpOutput);

  if (pdfExists) {
    fs.copyFileSync(tmpOutput, pdfOutput);
  }

  // Read the .log file for better error info
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

function copySiblingFiles(sourceDir: string, cacheDir: string): void {
  const copyExts = new Set([
    ".cls", ".sty", ".bst", ".bib", ".def", ".fd", ".cfg", ".clo",
    ".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg",
    ".ttf", ".otf",
  ]);
  try {
    for (const entry of fs.readdirSync(sourceDir)) {
      const ext = path.extname(entry).toLowerCase();
      if (copyExts.has(ext)) {
        const src = path.join(sourceDir, entry);
        const dst = path.join(cacheDir, entry);
        if (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) {
          fs.copyFileSync(src, dst);
        }
      }
    }
  } catch {}
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

  const xelatex = await findBinary("xelatex");
  const cacheDir = getCacheDir(sourceFile);
  const templatePath = installTemplate(document, cacheDir);

  const pdfOutput =
    outputPath || path.join(sourceDir, `${baseName}.pdf`);

  const rawText = document.getText();
  const { injected } = prepareForCompilation(rawText, sourceFile);

  const tmpSource = path.join(cacheDir, path.basename(sourceFile));
  fs.writeFileSync(tmpSource, injected, "utf-8");

  const tmpOutput = path.join(cacheDir, `${baseName}.pdf`);

  const ext = path.extname(sourceFile).toLowerCase();
  let fromFormat = `markdown+${PANDOC_EXTENSIONS}`;
  if (ext === ".rst") fromFormat = "rst";
  else if (ext === ".org") fromFormat = "org";
  else if (ext === ".txt") fromFormat = `markdown+${PANDOC_EXTENSIONS}`;

  const args = [
    tmpSource,
    "-o",
    tmpOutput,
    `--pdf-engine=${xelatex || "xelatex"}`,
    "--standalone",
    `--template=${templatePath}`,
    `--from=${fromFormat}`,
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

  // Also pick up .bib files next to the source
  copySiblingFiles(sourceDir, cacheDir);

  let stderr = "";
  let stdout = "";

  try {
    const result = await exec(pandoc, args, {
      cwd: sourceDir,
      timeout: 120_000,
      env: TEX_ENV,
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

  const errors = parseErrors(stderr, stdout);
  const duration = (Date.now() - start) / 1000;

  return {
    success: pdfExists,
    pdfPath: pdfExists ? pdfOutput : undefined,
    errors,
    log: stderr + "\n" + stdout,
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
