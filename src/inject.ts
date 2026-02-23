// Injection layer. Replaces executable ```{lang} blocks in the original
// markdown with their cached outputs (stdout, images, tables) prior to
// compilation or preview rendering. The display mode per block controls
// whether the reader sees code, output, both, or nothing.

import * as path from "path";
import * as fs from "fs";
import { BlockResult, CodeBlock, DisplayMode, parseCodeBlocks, parseRunConfig } from "./runner";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".svg", ".pdf", ".eps"]);

const PANDOC_LANG_MAP: Record<string, string> = {
  shell: "bash",
  sh: "bash",
  zsh: "bash",
};

function resolveDisplay(block: CodeBlock, defaultDisplay: DisplayMode): DisplayMode {
  return block.display || defaultDisplay;
}

export function injectResults(
  markdown: string,
  results: BlockResult[],
  defaultDisplay: DisplayMode = "output",
  workDir?: string,
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

    const replacement = buildBlockOutput(block, result, display, workDir);

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
  workDir?: string,
): string {
  if (display === "none") return "";

  const codeSection = formatCodeBlock(block, workDir);
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

function formatCodeBlock(block: CodeBlock, workDir?: string): string {
  const lang = pandocLang(block.lang);
  if (block.file) {
    const filePath = workDir ? path.resolve(workDir, block.file) : block.file;
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

  if (result.block.output) {
    const artifact = result.artifacts.get(result.block.output);
    if (artifact) {
      parts.push(formatArtifact(result.block.output, artifact, caption, label));
    } else if (result.stdout.trim()) {
      const text = result.stdout.trim();
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

  if (result.stdout.trim()) {
    const text = result.stdout.trim();
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
  const workDir = path.dirname(sourceFile);
  const cacheDir = path.join(workDir, ".inkwell", "outputs");

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

export function prepareForCompilation(
  markdown: string,
  sourceFile: string,
): { injected: string; tempFile: string } {
  const workDir = path.dirname(sourceFile);
  const blocks = parseCodeBlocks(markdown);
  if (!blocks.length) {
    return { injected: markdown, tempFile: sourceFile };
  }

  const runConfig = parseRunConfig(markdown);
  const defaultDisplay = runConfig.defaultDisplay || "output";
  const results = gatherCachedResults(markdown, sourceFile);
  const injected = injectResults(markdown, results, defaultDisplay, workDir);

  const ext = path.extname(sourceFile);
  const tempFile = path.join(workDir, ".inkwell", `compiled${ext}`);
  fs.mkdirSync(path.dirname(tempFile), { recursive: true });
  fs.writeFileSync(tempFile, injected, "utf-8");

  return { injected, tempFile };
}

export function prepareForPreview(
  markdown: string,
  sourceFile: string,
): string {
  const blocks = parseCodeBlocks(markdown);
  if (!blocks.length) return markdown;

  const workDir = path.dirname(sourceFile);
  const runConfig = parseRunConfig(markdown);
  const defaultDisplay = runConfig.defaultDisplay || "both";
  const results = gatherCachedResults(markdown, sourceFile);
  return injectResults(markdown, results, defaultDisplay, workDir);
}
