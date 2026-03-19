// Injection layer. Replaces executable ```{lang} blocks in the original
// markdown with their cached outputs (stdout, images, tables) prior to
// compilation or preview rendering. The display mode per block controls
// whether the reader sees code, output, both, or nothing.
//
// Also handles inline data binding:
//   - Variable store: code blocks export values via print("::inkwell key=val")
//     or a vars.json artifact. Referenced with {{key}} in markdown.
//   - Inline expressions: `{python} expr` backtick spans are batch-evaluated
//     in a Python process with the variable store pre-loaded.

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { BlockResult, CodeBlock, DisplayMode, parseCodeBlocks, parseRunConfig, RunConfig } from "./runner";
import { buildCodeBlockPath, findBinaryViaShell } from "./shell-env";
import { getInkwellOutputChannel } from "./inkwell-output";
import {
  getInkwellCompiledPath,
  getInkwellOutputsDir,
  getInkwellProjectRoot,
  resolveBlockFilePath,
} from "./config";

/** Session-local dirs prepended after `mmdc` is resolved via login shell. */
const injectPathShellPrepends: string[] = [];
let shellMmdcProbeDone = false;

function getInjectPath(): string {
  const base = buildCodeBlockPath();
  if (!injectPathShellPrepends.length) return base;
  return [...injectPathShellPrepends, base].join(":");
}

function getInjectEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: getInjectPath() };
}

function tryAugmentMmdcFromShell(): void {
  if (shellMmdcProbeDone) return;
  shellMmdcProbeDone = true;
  const resolved = findBinaryViaShell("mmdc");
  if (resolved) {
    const dir = path.dirname(resolved);
    if (dir && !injectPathShellPrepends.includes(dir)) {
      injectPathShellPrepends.push(dir);
    }
  }
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".svg", ".pdf", ".eps"]);

const PANDOC_LANG_MAP: Record<string, string> = {
  shell: "bash",
  sh: "bash",
  zsh: "bash",
};

const INKWELL_VAR_RE = /^::inkwell\s+(\w+)=(.+)$/;

function resolveDisplay(block: CodeBlock, defaultDisplay: DisplayMode): DisplayMode {
  if (block.display) return block.display;
  if (block.file) return "output";
  return defaultDisplay;
}

// ── Layer 1: Variable store ───────────────────────────────────────────

export function collectVariables(results: BlockResult[]): Map<string, string> {
  const vars = new Map<string, string>();

  for (const r of results) {
    if (r.exitCode !== 0) continue;

    for (const line of r.stdout.split("\n")) {
      const m = INKWELL_VAR_RE.exec(line.trim());
      if (m) vars.set(m[1], m[2]);
    }

    const varsJson = r.artifacts.get("vars");
    if (varsJson && path.extname(varsJson).toLowerCase() === ".json") {
      try {
        const parsed = JSON.parse(fs.readFileSync(varsJson, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            vars.set(k, String(v));
          }
        }
      } catch {}
    }
  }

  return vars;
}

export function stripInkwellLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !INKWELL_VAR_RE.test(line.trim()))
    .join("\n");
}

export function substituteVariables(
  markdown: string,
  vars: Map<string, string>,
): string {
  if (!vars.size) return markdown;
  return markdown.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return vars.get(key) ?? `{{${key}}}`;
  });
}

export function injectResults(
  markdown: string,
  results: BlockResult[],
  defaultDisplay: DisplayMode = "output",
  docDir: string,
  projectRoot: string,
): string {
  if (!results.length) return markdown;

  const resultsByIndex = new Map<number, BlockResult>();
  for (const r of results) {
    resultsByIndex.set(r.block.index, r);
  }

  const blocks = parseCodeBlocks(markdown);
  // Walk blocks in document order, tracking a character offset so that
  // earlier replacements (which may change string length) do not shift
  // the positions of later blocks.
  let output = markdown;
  let offset = 0;

  for (const block of blocks) {
    const result = resultsByIndex.get(block.index);
    const display = resolveDisplay(block, defaultDisplay);

    const start = output.indexOf(block.raw, offset);
    if (start === -1) continue;

    const replacement = buildBlockOutput(block, result, display, docDir, projectRoot);

    output =
      output.substring(0, start) +
      replacement +
      output.substring(start + block.raw.length);
    offset = start + replacement.length;
  }

  return output;
}

function buildBlockOutput(
  block: CodeBlock,
  result: BlockResult | undefined,
  display: DisplayMode,
  docDir: string,
  projectRoot: string,
): string {
  if (display === "none") return "";

  const codeSection = formatCodeBlock(block, docDir, projectRoot);
  const outputSection = result && result.exitCode === 0
    ? buildOutputContent(result) : null;

  if (display === "code") return codeSection;
  if (display === "output") return outputSection || "";
  // "both"
  const parts: string[] = [codeSection];
  if (outputSection) parts.push(outputSection);
  return parts.join("\n\n");
}

function pandocLang(lang: string): string {
  const lower = lang.toLowerCase();
  return PANDOC_LANG_MAP[lower] || lower;
}

function formatCodeBlock(block: CodeBlock, docDir: string, projectRoot: string): string {
  const lang = pandocLang(block.lang);
  if (block.file) {
    const filePath = resolveBlockFilePath(block.file, docDir, projectRoot);
    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf-8").trim();
    } catch {
      source = `# ${block.file}`;
    }
    return "```" + lang + "\n" + source + "\n```";
  }
  return "```" + lang + "\n" + block.source + "\n```";
}

function buildOutputContent(result: BlockResult): string | null {
  const parts: string[] = [];
  const caption = result.block.caption;
  const label = result.block.label;
  const stdout = stripInkwellLines(result.stdout);

  if (result.block.output) {
    const artifact = result.artifacts.get(result.block.output);
    if (artifact) {
      parts.push(formatArtifact(result.block.output, artifact, caption, label));
    } else if (stdout.trim()) {
      const text = stdout.trim();
      if (looksLikeMarkdown(text)) {
        parts.push(text);
      } else {
        parts.push("```text\n" + text + "\n```");
      }
    }
    return parts.length ? parts.join("\n\n") : null;
  }

  for (const [name, filepath] of result.artifacts) {
    parts.push(formatArtifact(name, filepath, caption, label));
  }

  if (stdout.trim()) {
    const text = stdout.trim();
    if (looksLikeMarkdown(text)) {
      parts.push(text);
    } else {
      parts.push("```text\n" + text + "\n```");
    }
  }

  return parts.length ? parts.join("\n\n") : null;
}

function formatArtifact(
  name: string,
  filepath: string,
  caption?: string,
  label?: string,
): string {
  const ext = path.extname(filepath).toLowerCase();

  if (IMAGE_EXTS.has(ext)) {
    const alt = caption || name;
    const labelAttr = label ? `{#fig:${label}}` : "";
    return `![${alt}](${filepath})${labelAttr}`;
  }

  try {
    const content = fs.readFileSync(filepath, "utf-8");

    if (ext === ".md" || ext === ".markdown") {
      return content.trim();
    }

    if (ext === ".tex" || ext === ".latex") {
      return content.trim();
    }

    if (ext === ".csv") {
      const table = csvToMarkdownTable(content);
      if (caption) {
        return table + "\n\n: " + caption + (label ? ` {#tbl:${label}}` : "");
      }
      return table;
    }

    if (ext === ".json") {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === "object") {
        const table = jsonArrayToTable(parsed);
        if (caption) {
          return table + "\n\n: " + caption + (label ? ` {#tbl:${label}}` : "");
        }
        return table;
      }
      return "```json\n" + content.trim() + "\n```";
    }

    return "```\n" + content.trim() + "\n```";
  } catch {
    const alt = caption || name;
    return `![${alt}](${filepath})`;
  }
}

// Heuristic: if stdout starts with a markdown-ish character, pass it
// through raw so tables/headings/images render correctly in the preview.
function looksLikeMarkdown(text: string): boolean {
  return /^[#|>*\-\d]/.test(text) || text.includes("![");
}

function csvToMarkdownTable(csv: string): string {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return "```\n" + csv + "\n```";

  const header = parseCsvLine(lines[0]);
  const separator = header.map(() => "---");
  const rows = lines.slice(1).map(parseCsvLine);

  return [
    "| " + header.join(" | ") + " |",
    "| " + separator.join(" | ") + " |",
    ...rows.map((r) => "| " + r.join(" | ") + " |"),
  ].join("\n");
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function jsonArrayToTable(arr: Record<string, any>[]): string {
  const keys = Object.keys(arr[0]);
  const header = "| " + keys.join(" | ") + " |";
  const separator = "| " + keys.map(() => "---").join(" | ") + " |";
  const rows = arr.map(
    (row) => "| " + keys.map((k) => String(row[k] ?? "")).join(" | ") + " |"
  );
  return [header, separator, ...rows].join("\n");
}

export function gatherCachedResults(
  markdown: string,
  sourceFile: string,
): BlockResult[] {
  const cacheDir = getInkwellOutputsDir(sourceFile);

  const blocks = parseCodeBlocks(markdown);
  const results: BlockResult[] = [];

  for (const block of blocks) {
    const blockDir = path.join(cacheDir, `block_${block.index}`);
    let stdout = "";
    try {
      stdout = fs.readFileSync(path.join(blockDir, "stdout.txt"), "utf-8");
    } catch {}

    const artifacts = new Map<string, string>();
    try {
      for (const entry of fs.readdirSync(blockDir)) {
        if (entry === "stdout.txt" || entry === "stderr.txt" || entry.startsWith("block_")) continue;
        if (fs.statSync(path.join(blockDir, entry)).isFile()) {
          const name = path.basename(entry, path.extname(entry));
          artifacts.set(name, path.join(blockDir, entry));
        }
      }
    } catch {}

    results.push({
      block,
      stdout,
      stderr: "",
      exitCode: 0,
      artifacts,
      cached: true,
    });
  }

  return results;
}

// ── Layer 2: Inline expressions ───────────────────────────────────────

const INLINE_EXPR_RE = /`\{python\}\s+([^`]+)`/g;

function resolvePython(runConfig: RunConfig, docDir: string, projectRoot: string): string {
  const envSpec = runConfig.pythonEnv;
  if (envSpec) {
    const home = process.env.HOME || "~";
    for (const base of [projectRoot, docDir]) {
      const resolved = path.resolve(base, envSpec.replace(/^~/, home));
      for (const bin of ["bin/python3", "bin/python"]) {
        const full = path.join(resolved, bin);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return "python3";
}

export function evaluateInlineExpressions(
  markdown: string,
  vars: Map<string, string>,
  runConfig: RunConfig,
  docDir: string,
  projectRoot: string,
  cacheDir: string,
): string {
  const matches: { full: string; expr: string }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_EXPR_RE.source, "g");
  while ((m = re.exec(markdown)) !== null) {
    matches.push({ full: m[0], expr: m[1].trim() });
  }
  if (!matches.length) return markdown;

  const exprs = matches.map((e) => e.expr);

  const h = crypto.createHash("sha256");
  h.update(JSON.stringify(exprs));
  for (const [k, v] of vars) h.update(`\0${k}=${v}`);
  const hash = h.digest("hex").substring(0, 16);

  const evalDir = path.join(cacheDir, "inline_eval");
  fs.mkdirSync(evalDir, { recursive: true });
  const cachePath = path.join(evalDir, "cache.json");

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (cached.hash === hash && Array.isArray(cached.values) && cached.values.length === exprs.length) {
      return applyInlineResults(markdown, matches, cached.values);
    }
  } catch {}

  const lines: string[] = [];
  for (const [k, v] of vars) {
    lines.push(`${k} = ${JSON.stringify(v)}`);
    const num = Number(v);
    if (!isNaN(num) && v.trim() !== "") {
      lines.push(`try:\n    ${k} = type(${JSON.stringify(v)})(${num})\nexcept:\n    pass`);
    }
  }
  lines.push("");
  for (let i = 0; i < exprs.length; i++) {
    lines.push(`try:`);
    lines.push(`    __r = ${exprs[i]}`);
    lines.push(`    print(f"::result_${i}={__r}")`);
    lines.push(`except Exception as __e:`);
    lines.push(`    print(f"::result_${i}=??({__e})")`);
  }

  const script = lines.join("\n");
  const scriptPath = path.join(evalDir, "eval.py");
  fs.writeFileSync(scriptPath, script, "utf-8");

  const python = resolvePython(runConfig, docDir, projectRoot);

  let stdout: string;
  try {
    stdout = execFileSync(python, ["-u", scriptPath], {
      cwd: projectRoot,
      timeout: 30_000,
      encoding: "utf-8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
  } catch {
    return markdown;
  }

  const values: string[] = new Array(exprs.length).fill("??");
  for (const line of stdout.split("\n")) {
    const rm = /^::result_(\d+)=(.+)$/.exec(line.trim());
    if (rm) {
      const idx = parseInt(rm[1], 10);
      if (idx >= 0 && idx < values.length) values[idx] = rm[2];
    }
  }

  try {
    fs.writeFileSync(cachePath, JSON.stringify({ hash, values }), "utf-8");
  } catch {}

  return applyInlineResults(markdown, matches, values);
}

function applyInlineResults(
  markdown: string,
  matches: { full: string; expr: string }[],
  values: string[],
): string {
  let result = markdown;
  for (let i = 0; i < matches.length; i++) {
    result = result.replace(matches[i].full, values[i]);
  }
  return result;
}

// ── Layer 3: Mermaid diagrams ─────────────────────────────────────────

const MERMAID_BLOCK_RE = /^```(?:\{mermaid([^}]*)\}|mermaid)\s*\n([\s\S]*?)^```/gm;

let _mmdcAvailable: boolean | undefined;
let _mmdcCheckTime = 0;
const MMDC_CACHE_TTL = 30_000;

function mmdcAvailable(): boolean {
  if (_mmdcAvailable !== undefined && Date.now() - _mmdcCheckTime < MMDC_CACHE_TTL) {
    return _mmdcAvailable;
  }
  const tryProbe = (): boolean => {
    execFileSync("mmdc", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: "pipe",
      env: getInjectEnv(),
    });
    return true;
  };
  try {
    tryProbe();
    _mmdcAvailable = true;
  } catch {
    tryAugmentMmdcFromShell();
    try {
      tryProbe();
      _mmdcAvailable = true;
    } catch {
      _mmdcAvailable = false;
      const p = getInjectPath();
      const head = p.split(":").slice(0, 8).join(":");
      getInkwellOutputChannel().appendLine(
        `[mermaid] mmdc not found or failed --version. PATH head (extension-constructed): ${head}${p.split(":").length > 8 ? " ..." : ""}`,
      );
    }
  }
  _mmdcCheckTime = Date.now();
  return _mmdcAvailable;
}

function parseMermaidAttrs(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/** `projectRoot` — Inkwell project directory containing `.inkwell/` (not the `.md` folder when nested). */
export function renderMermaidBlocks(markdown: string, projectRoot: string): string {
  if (!mmdcAvailable()) return markdown;

  const matches: { raw: string; attrsStr?: string; source: string }[] = [];
  MERMAID_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MERMAID_BLOCK_RE.exec(markdown)) !== null) {
    matches.push({ raw: m[0], attrsStr: m[1], source: m[2].trim() });
  }
  if (!matches.length) return markdown;

  const mermaidDir = path.join(projectRoot, ".inkwell", "mermaid");
  fs.mkdirSync(mermaidDir, { recursive: true });

  let output = markdown;
  let offset = 0;

  for (const match of matches) {
    const attrs = parseMermaidAttrs(match.attrsStr);
    const hash = crypto
      .createHash("sha256")
      .update(match.source)
      .digest("hex")
      .substring(0, 16);

    const svgPath = path.join(mermaidDir, `${hash}.svg`);
    const metaPath = path.join(mermaidDir, `${hash}.json`);

    let cached = false;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.hash === hash && fs.existsSync(svgPath)) cached = true;
    } catch {}

    const pngPath = path.join(mermaidDir, `${hash}.png`);

    if (!cached) {
      const inputPath = path.join(mermaidDir, `${hash}.mmd`);
      fs.writeFileSync(inputPath, match.source, "utf-8");
      try {
        execFileSync("mmdc", ["-i", inputPath, "-o", svgPath], {
          cwd: projectRoot,
          timeout: 30_000,
          stdio: "pipe",
          env: getInjectEnv(),
        });
        if (!fs.existsSync(svgPath)) {
          const alt = svgPath.replace(".svg", "-1.svg");
          if (fs.existsSync(alt)) fs.renameSync(alt, svgPath);
        }
        execFileSync("mmdc", ["-i", inputPath, "-o", pngPath, "-s", "4"], {
          cwd: projectRoot,
          timeout: 30_000,
          stdio: "pipe",
          env: getInjectEnv(),
        });
        if (!fs.existsSync(pngPath)) {
          const alt = pngPath.replace(".png", "-1.png");
          if (fs.existsSync(alt)) fs.renameSync(alt, pngPath);
        }
        if (fs.existsSync(svgPath) || fs.existsSync(pngPath)) {
          fs.writeFileSync(metaPath, JSON.stringify({ hash }), "utf-8");
        }
      } catch (err: any) {
        const msg = err?.stderr?.toString() || err?.message || "unknown error";
        console.error(`[inkwell] mermaid render failed for block: ${msg}`);
        continue;
      }
    }

    if (!fs.existsSync(pngPath) && !fs.existsSync(svgPath)) continue;

    const imagePath = fs.existsSync(pngPath) ? pngPath : svgPath;
    const alt = attrs.caption || "Mermaid diagram";
    const labelAttr = attrs.label ? `{#fig:${attrs.label}}` : "";
    const replacement = `![${alt}](${imagePath})${labelAttr}`;

    const start = output.indexOf(match.raw, offset);
    if (start === -1) continue;

    output =
      output.substring(0, start) +
      replacement +
      output.substring(start + match.raw.length);
    offset = start + replacement.length;
  }

  return output;
}

function normalizeMermaidForPreview(markdown: string): string {
  return markdown.replace(/^```\{mermaid[^}]*\}\s*$/gm, "```mermaid");
}

// ── Compilation and preview entry points ──────────────────────────────

export function prepareForCompilation(
  markdown: string,
  sourceFile: string,
): { injected: string; tempFile: string } {
  const docDir = path.dirname(sourceFile);
  const projectRoot = getInkwellProjectRoot(sourceFile);

  const hasMermaid = /^```(?:\{mermaid|mermaid)/m.test(markdown);
  const processed = hasMermaid
    ? renderMermaidBlocks(markdown, projectRoot)
    : markdown;

  const blocks = parseCodeBlocks(processed);
  const hasBlocks = blocks.length > 0;
  const hasVarRefs = /\{\{\w+\}\}/.test(processed);
  const hasInlineExprs = /`\{python\}\s+[^`]+`/.test(processed);

  if (!hasBlocks && !hasVarRefs && !hasInlineExprs && !hasMermaid) {
    return { injected: markdown, tempFile: sourceFile };
  }

  const runConfig = parseRunConfig(processed);
  const defaultDisplay = runConfig.defaultDisplay || "output";
  const results = gatherCachedResults(processed, sourceFile);
  const vars = collectVariables(results);

  let injected = injectResults(processed, results, defaultDisplay, docDir, projectRoot);
  injected = substituteVariables(injected, vars);

  const cacheDir = getInkwellOutputsDir(sourceFile);
  injected = evaluateInlineExpressions(injected, vars, runConfig, docDir, projectRoot, cacheDir);

  const tempFile = getInkwellCompiledPath(sourceFile);
  fs.mkdirSync(path.dirname(tempFile), { recursive: true });
  fs.writeFileSync(tempFile, injected, "utf-8");

  return { injected, tempFile };
}

export function prepareForPreview(
  markdown: string,
  sourceFile: string,
): string {
  const hasMermaid = /^```\{mermaid/m.test(markdown);
  const processed = hasMermaid
    ? normalizeMermaidForPreview(markdown)
    : markdown;

  const blocks = parseCodeBlocks(processed);
  const hasBlocks = blocks.length > 0;
  const hasVarRefs = /\{\{\w+\}\}/.test(processed);
  const hasInlineExprs = /`\{python\}\s+[^`]+`/.test(processed);

  if (!hasBlocks && !hasVarRefs && !hasInlineExprs) return processed;

  const docDir = path.dirname(sourceFile);
  const projectRoot = getInkwellProjectRoot(sourceFile);
  const runConfig = parseRunConfig(processed);
  const defaultDisplay = runConfig.defaultDisplay || "output";
  const results = gatherCachedResults(processed, sourceFile);
  const vars = collectVariables(results);

  let injected = injectResults(processed, results, defaultDisplay, docDir, projectRoot);
  injected = substituteVariables(injected, vars);

  const cacheDir = getInkwellOutputsDir(sourceFile);
  injected = evaluateInlineExpressions(injected, vars, runConfig, docDir, projectRoot, cacheDir);

  return injected;
}
