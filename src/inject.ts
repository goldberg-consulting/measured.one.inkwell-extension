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
import MarkdownIt from "markdown-it";
import { execFileSync } from "child_process";
import { BlockResult, CodeBlock, DisplayMode, readCurrentRunResults, parseCodeBlocks, parseQuotedAttrs, parseRunConfig, resolveVenvPython, RunConfig } from "./runner";
import { buildCodeBlockPath, findBinaryViaShell } from "./shell-env";
import { getInkwellOutputChannel } from "./inkwell-output";
import { fingerprintBlock, resolveRunSource } from "./run-store";
import * as vscode from "vscode";
import { artifactTableLabel, decodeTableData, encodeTableData, literalFence, parseCsvTable, parseJsonTable, TABLE_DATA_LIMITS,
  TABLE_DATA_ERROR_FENCE, TableDataDiagnostic, TableDataError, tableDataDiagnostic } from "./table-data";
import {
  getInkwellCompiledPath,
  getInkwellOutputsDir,
  getInkwellProjectRoot,
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

// collectVariables runs on every preview refresh; repeat the non-scalar
// vars.json warning only when the offending key set changes.
let lastSkippedVarsWarning = "";

function resolveDisplay(block: CodeBlock, defaultDisplay: DisplayMode): DisplayMode {
  if (block.display) return block.display;
  return defaultDisplay;
}

// ── Layer 1: Variable store ───────────────────────────────────────────

export function collectVariables(results: BlockResult[]): Map<string, string> {
  const vars = new Map<string, string>();

  for (const r of results) {
    if (r.cacheStatus === "miss") continue;
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
          // Bindings are a flat scalar contract. Nested objects would
          // stringify to "[object Object]" and arrays to comma-joined
          // fragments — both ship silently into the PDF, so refuse them
          // loudly instead.
          const skipped: string[] = [];
          for (const [k, v] of Object.entries(parsed)) {
            const t = typeof v;
            if (v === null || t === "string" || t === "number" || t === "boolean") {
              vars.set(k, String(v));
            } else {
              skipped.push(k);
            }
          }
          if (skipped.length) {
            const warning = skipped.sort().join(", ");
            if (warning !== lastSkippedVarsWarning) {
              lastSkippedVarsWarning = warning;
              getInkwellOutputChannel().appendLine(
                `[inkwell] vars.json: skipped non-scalar keys: ${warning}. ` +
                `Bindings must be strings, numbers, or booleans (objects render as "[object Object]"); ` +
                `flatten them in the exporting code block.`,
              );
            }
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

/** Generated cell/diagnostic text is data, including binding-looking strings. */
function shieldTableFences(markdown: string, inspectMetadata?: (values: string[]) => void): { text: string; restore: (text: string) => string } {
  const opening = /^(`{3,})inkwell-table-(?:data|error)[ \t]*\r?\n/gm;
  const protectedText = new Map<string, string>();
  let text = "";
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(markdown))) {
    const closing = new RegExp("^`{" + match[1].length + ",}[ \\t]*(?:\\r?\\n|$)", "gm");
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(markdown);
    const nextOffset = end ? closing.lastIndex : markdown.length;
    if (inspectMetadata && match[0].includes("inkwell-table-data")) {
      try {
        const table = decodeTableData(markdown.slice(opening.lastIndex, end?.index ?? markdown.length));
        inspectMetadata([table.caption || "", table.label || "", ...Object.values(table.attributes)]);
      } catch { /* Invalid private payloads are diagnosed by the table renderer. */ }
    }
    let token: string;
    do { token = `INKWELL_LITERAL_${crypto.randomUUID()}_END`; } while (markdown.includes(token));
    const original = markdown.slice(match.index, nextOffset);
    const placeholder = token + (original.match(/\r?\n$/)?.[0] || "");
    protectedText.set(placeholder, original);
    text += markdown.slice(offset, match.index) + placeholder;
    offset = nextOffset;
    opening.lastIndex = nextOffset;
  }
  text += markdown.slice(offset);
  return { text, restore: (transformed) => {
    for (const [token, original] of protectedText) transformed = transformed.replace(token, () => original);
    return transformed;
  } };
}

function escapedBacktick(text: string, offset: number): boolean {
  let slashes = 0;
  while (offset > 0 && text[--offset] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Code examples are literal; only explicit single-backtick Python spans run.
 * Parse Markdown blocks so nested fences and indented code stay protected too.
 * YAML metadata remains eligible for binding before configuration resolution.
 */
function shieldBindingLiterals(markdown: string, inspectMetadata?: (values: string[]) => void): { text: string; restore: (text: string) => string } {
  const tables = shieldTableFences(markdown, inspectMetadata);
  const frontmatter = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n)[\s\S]*?(?:\r\n|\r|\n)(?:---|\.\.\.)[ \t]*(?:\r\n|\r|\n|$)/.exec(tables.text)?.[0].length || 0;
  const body = tables.text.slice(frontmatter), starts = [0];
  for (const match of body.matchAll(/\r\n|\r|\n/g)) starts.push(match.index! + match[0].length);
  const ranges: Array<[number, number]> = [];
  const tokens = new MarkdownIt().parse(body, {});
  for (const token of tokens) {
    if (!token.map) continue;
    const start = starts[token.map[0]], end = starts[token.map[1]] ?? body.length;
    if (token.type === "fence" || token.type === "code_block") {
      ranges.push([start, end]);
    } else if (token.type === "inline") {
      const runs = [...body.slice(start, end).matchAll(/`+/g)].map(match => ({ start: start + match.index!, length: match[0].length }));
      const next = new Map<number, number>(), closing = new Map<number, number>();
      for (let i = runs.length - 1; i >= 0; i--) {
        const found = next.get(runs[i].length);
        if (found !== undefined) closing.set(i, found);
        next.set(runs[i].length, i);
      }
      for (let i = 0; i < runs.length; i++) {
        const close = closing.get(i);
        if (escapedBacktick(body, runs[i].start) || close === undefined) continue;
        const from = runs[i].start, to = runs[close].start + runs[close].length;
        if (runs[i].length !== 1 || !/^`\{python\}\s+[^`]+`$/.test(body.slice(from, to))) ranges.push([from, to]);
        i = close;
      }
    }
  }
  const literals = new Map<string, string>();
  let text = tables.text.slice(0, frontmatter), offset = 0;
  for (const [start, end] of ranges.sort(([a], [b]) => a - b)) {
    if (start < offset) continue;
    let token: string;
    do { token = `INKWELL_CODE_${crypto.randomUUID()}_END`; } while (tables.text.includes(token));
    literals.set(token, body.slice(start, end));
    text += body.slice(offset, start) + token;
    offset = end;
  }
  text += body.slice(offset);
  return { text, restore: transformed => {
    for (const [token, original] of literals) transformed = transformed.replace(token, () => original);
    return tables.restore(transformed);
  } };
}

export function substituteVariables(
  markdown: string,
  vars: Map<string, string>,
): string {
  if (!vars.size) return markdown;
  const literal = shieldBindingLiterals(markdown);
  return literal.restore(literal.text.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return vars.get(key) ?? `{{${key}}}`;
  }));
}

export interface InjectionOptions { sourceFile?: string; tableDiagnostics?: TableDataDiagnostic[]; variables?: Map<string, string> }

export function injectResults(
  markdown: string,
  results: BlockResult[],
  defaultDisplay: DisplayMode = "output",
  docDir: string,
  projectRoot: string,
  options: InjectionOptions = {},
): string {
  if (!results.length) return markdown;
  const resolvedOptions = { ...options, variables: options.variables ?? collectVariables(results) };

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
    const effectiveBlock = result?.block || block;
    const display = resolveDisplay(effectiveBlock, defaultDisplay);

    const start = output.indexOf(block.raw, offset);
    if (start === -1) continue;

    const replacement = buildBlockOutput(effectiveBlock, result, display, docDir, projectRoot, resolvedOptions);

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
  options: InjectionOptions,
): string {
  if (display === "none") return "";

  const codeSection = formatCodeBlock(block, docDir, projectRoot);
  const outputSection = result && result.exitCode === 0 && result.cacheStatus !== "miss" && display !== "code"
    ? buildOutputContent(result, options.sourceFile || docDir, options) : null;

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
    let source: string;
    try {
      const filePath = resolveRunSource(block.file, docDir, projectRoot);
      source = fs.readFileSync(filePath, "utf-8").trim();
    } catch {
      source = `# ${block.file}`;
    }
    return "```" + lang + "\n" + source + "\n```";
  }
  return "```" + lang + "\n" + block.source + "\n```";
}

function buildOutputContent(result: BlockResult, sourceFile: string, options: InjectionOptions): string | null {
  const parts: string[] = [];
  const stdout = stripInkwellLines(result.stdout);
  const blockId = result.blockId || result.block.id || crypto.createHash("sha256")
    .update(JSON.stringify([result.block.lang, result.block.file, result.block.source])).digest("hex");
  const format = (name: string, filepath: string, multiple: boolean): string => formatArtifact(name, filepath,
    result.block, sourceFile, blockId, multiple, options);

  if (result.block.output) {
    const artifact = result.artifacts.get(result.block.output);
    if (artifact) {
      parts.push(format(result.block.output, artifact, false));
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
    parts.push(format(name, filepath, result.artifacts.size > 1));
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
  block: CodeBlock,
  sourceFile: string,
  blockId: string,
  multiple: boolean,
  options: InjectionOptions,
): string {
  const ext = path.extname(filepath).toLowerCase();
  // These strings originate in the authored block, while cell values originate in data files.
  const bindMetadata = (value: string): string => value.replace(/\{\{(\w+)\}\}/g, (match, key) => options.variables?.get(key) ?? match);
  const caption = block.caption === undefined ? undefined : bindMetadata(block.caption);
  const label = block.label === undefined ? undefined : bindMetadata(block.label);

  if (IMAGE_EXTS.has(ext)) {
    const alt = caption || name;
    const explicit = label?.replace(/^fig:/, "");
    const figureLabel = explicit && artifactTableLabel(sourceFile, blockId, name, explicit, multiple).replace(/^tbl:/, "fig:");
    const labelAttr = figureLabel ? `{#${figureLabel}}` : "";
    return `![${alt}](${filepath})${labelAttr}`;
  }

  try {
    const isTable = ext === ".csv" || ext === ".json";
    const bytes = isTable ? readTableArtifact(filepath) : fs.readFileSync(filepath);
    const content = bytes.toString("utf-8");
    if (isTable && !Buffer.from(content, "utf-8").equals(bytes)) throw new TableDataError("table-encoding", "Table artifact is not valid UTF-8. Export the artifact with UTF-8 encoding.");

    if (ext === ".md" || ext === ".markdown") {
      return content.trim();
    }

    if (ext === ".tex" || ext === ".latex") {
      return content.trim();
    }

    if (isTable) {
      const metadata = { caption, label: artifactTableLabel(sourceFile, blockId, name, label, multiple),
        attributes: { ...Object.fromEntries(Object.entries(block.attributes || {}).map(([key, value]) => [key, bindMetadata(value)])),
          "data-inkwell-artifact": name, "data-inkwell-block": blockId } };
      const table = ext === ".csv" ? parseCsvTable(content, metadata) : parseJsonTable(content, metadata);
      return table ? encodeTableData(table) : literalFence(content.trim(), "json");
    }

    return literalFence(content.trim(), "");
  } catch (error) {
    const diagnostic = tableDataDiagnostic(error, filepath);
    options.tableDiagnostics?.push(diagnostic);
    return literalFence(`Inkwell table error: ${diagnostic.message}\nArtifact: ${filepath}`, TABLE_DATA_ERROR_FENCE);
  }
}

function readTableArtifact(filepath: string): Buffer {
  const file = fs.openSync(filepath, "r");
  try {
    const limit = TABLE_DATA_LIMITS.sourceBytes;
    const tooLarge = () => new TableDataError("table-source-limit", "Table artifact exceeds the 5 MiB input limit. Export a smaller table or split it into separate artifacts.");
    if (fs.fstatSync(file).size > limit) throw tooLarge();
    // The extra byte detects growth after the size check without an unbounded read.
    const buffer = Buffer.allocUnsafe(limit + 1);
    let size = 0, read: number;
    while (size <= limit && (read = fs.readSync(file, buffer, size, buffer.length - size, null))) size += read;
    if (size > limit) throw tooLarge();
    return buffer.subarray(0, size);
  } finally { fs.closeSync(file); }
}

// Heuristic: if stdout starts with a markdown-ish character, pass it
// through raw so tables/headings/images render correctly in the preview.
function looksLikeMarkdown(text: string): boolean {
  return /^[#|>*\-\d]/.test(text) || text.includes("![");
}

export function gatherCachedResults(
  markdown: string,
  sourceFile: string,
): BlockResult[] {
  return readCurrentRunResults(markdown, sourceFile);
}

// ── Layer 2: Inline expressions ───────────────────────────────────────

const INLINE_EXPR_RE = /(?<!`)`\{python\}\s+([^`]+)`(?!`)/g;

function resolvePython(runConfig: RunConfig, docDir: string, projectRoot: string): string {
  if (runConfig.pythonEnv) {
    const bin = resolveVenvPython(runConfig.pythonEnv, projectRoot, docDir);
    if (bin) return bin;
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
  if (vscode.workspace.isTrusted === false) return markdown;
  const literal = shieldBindingLiterals(markdown);
  return literal.restore(evaluateDocumentExpressions(literal.text, vars, runConfig, docDir, projectRoot, cacheDir));
}

function evaluateDocumentExpressions(
  markdown: string, vars: Map<string, string>, runConfig: RunConfig, docDir: string, projectRoot: string, cacheDir: string,
): string {
  const matches: { full: string; expr: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_EXPR_RE.source, "g");
  while ((m = re.exec(markdown)) !== null) {
    if (escapedBacktick(markdown, m.index)) continue;
    matches.push({ full: m[0], expr: m[1].trim(), start: m.index });
  }
  if (!matches.length) return markdown;

  const exprs = matches.map((e) => e.expr);

  const h = crypto.createHash("sha256");
  h.update("inline-evaluation-v2");
  h.update(JSON.stringify(exprs));
  for (const [k, v] of vars) h.update(`\0${k}=${v}`);
  const python = resolvePython(runConfig, docDir, projectRoot);
  const interpreter = { cmd: python, args: ["-u"], envVars: { PYTHONDONTWRITEBYTECODE: "1" }, label: python };
  const context = fingerprintBlock({ index: 0, lang: "python", source: JSON.stringify(exprs),
    startLine: 0, endLine: 0, raw: "" }, docDir, projectRoot, interpreter);
  h.update(context.hash);
  const hash = h.digest("hex");

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

  let stdout: string;
  try {
    stdout = execFileSync(context.interpreter.path, ["-u", scriptPath], {
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
  matches: { full: string; expr: string; start: number }[],
  values: string[],
): string {
  let result = markdown;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, full } = matches[i];
    result = result.slice(0, start) + values[i] + result.slice(start + full.length);
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
    const attrs = parseQuotedAttrs(match.attrsStr || "");
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

/** Unique `{{key}}` placeholders that survived substitution (frontmatter included). */
export function collectUnresolvedVars(markdown: string): string[] {
  const out = new Set<string>();
  const collect = (text: string) => { for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) out.add(m[1]); };
  collect(shieldBindingLiterals(markdown, values => values.forEach(collect)).text);
  return [...out];
}

export function prepareForCompilation(
  markdown: string,
  sourceFile: string,
): { injected: string; tempFile: string; unresolvedVars: string[]; tableDiagnostics: TableDataDiagnostic[] } {
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
    return { injected: markdown, tempFile: sourceFile, unresolvedVars: [], tableDiagnostics: [] };
  }

  const runConfig = parseRunConfig(processed, sourceFile);
  const defaultDisplay = runConfig.defaultDisplay || "output";
  const results = gatherCachedResults(processed, sourceFile);
  const vars = collectVariables(results);

  const tableDiagnostics: TableDataDiagnostic[] = [];
  let injected = injectResults(processed, results, defaultDisplay, docDir, projectRoot, { sourceFile, tableDiagnostics, variables: vars });
  injected = substituteVariables(injected, vars);

  const cacheDir = getInkwellOutputsDir(sourceFile);
  if (vscode.workspace.isTrusted) injected = evaluateInlineExpressions(injected, vars, runConfig, docDir, projectRoot, cacheDir);

  // A leftover {{key}} means a typo or a stale/missing binding; it ships
  // literally into the PDF, so the compile surfaces it as a warning.
  const unresolvedVars = collectUnresolvedVars(injected);

  const tempFile = getInkwellCompiledPath(sourceFile);
  fs.mkdirSync(path.dirname(tempFile), { recursive: true });
  fs.writeFileSync(tempFile, injected, "utf-8");

  return { injected, tempFile, unresolvedVars, tableDiagnostics };
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
  const runConfig = parseRunConfig(processed, sourceFile);
  const defaultDisplay = runConfig.defaultDisplay || "output";
  const results = gatherCachedResults(processed, sourceFile);
  const vars = collectVariables(results);

  let injected = injectResults(processed, results, defaultDisplay, docDir, projectRoot, { sourceFile, variables: vars });
  injected = substituteVariables(injected, vars);

  const cacheDir = getInkwellOutputsDir(sourceFile);
  if (vscode.workspace.isTrusted) injected = evaluateInlineExpressions(injected, vars, runConfig, docDir, projectRoot, cacheDir);

  return injected;
}
