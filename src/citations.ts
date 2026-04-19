// Citations and bibliography for the preview. Two resolution paths:
//   (A) Shell out to `pandoc --citeproc` when pandoc is on PATH, which
//       gives perfect parity with the compile pipeline (same CSL, same
//       bib files, same formatting).
//   (B) Tiny in-process .bib parser fallback for environments where
//       pandoc is unreachable or the fast path times out.
//
// Results are cached under .inkwell/.cache/preview-cites/<hash>.html,
// keyed on the citation tokens, resolved .bib paths and their mtimes,
// the optional CSL path and its mtime, and the link-citations flag.
// The cache lives alongside other Inkwell artifacts so it moves with
// the project and can be safely wiped by clearing .inkwell/.cache/.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { findBibFiles, findCslFile, getInkwellProjectRoot } from "./config";
import { findBinaryViaShell } from "./shell-env";

function runPandoc(
  binary: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve(undefined);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve(undefined);
    }, timeoutMs);

    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
      } else {
        resolve(undefined);
      }
    });

    try {
      child.stdin.end(input, "utf-8");
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      }
    }
  });
}

export interface CitationOptions {
  sourceFile: string;
  projectRoot: string;
  bibliography?: string[];
  csl?: string;
  linkCitations?: boolean;
  referencesHeading?: string;
}

export interface CitationRenderResult {
  body: string;
  referencesHtml?: string;
  resolvedKeys: Set<string>;
  missingKeys: Set<string>;
  engine: "pandoc" | "fallback" | "none";
}

/** Shape of a pandoc-style inline citation: [@key, p. 23], [-@key], [@a; @b]. */
interface CitationToken {
  full: string;
  keys: string[];
  suppressAuthor: boolean[];
  raw: string;
}

const CITE_BRACKET_RE = /\[(?=[^[\]]*@)((?:[^[\]])*)\]/g;
const CITE_KEY_RE = /(-?)@([\w:./-][\w:./-]*)/g;

export function extractCitations(markdown: string): CitationToken[] {
  const tokens: CitationToken[] = [];
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");

  CITE_BRACKET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_BRACKET_RE.exec(stripped)) !== null) {
    const inner = m[1];
    const keys: string[] = [];
    const suppress: boolean[] = [];
    CITE_KEY_RE.lastIndex = 0;
    let km: RegExpExecArray | null;
    while ((km = CITE_KEY_RE.exec(inner)) !== null) {
      suppress.push(km[1] === "-");
      keys.push(km[2]);
    }
    if (keys.length) {
      tokens.push({ full: m[0], keys, suppressAuthor: suppress, raw: inner });
    }
  }
  return tokens;
}

function bibFilesMtime(bibFiles: string[]): number[] {
  return bibFiles.map((f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function cacheKey(
  tokens: CitationToken[],
  bibFiles: string[],
  cslFile: string | undefined,
  linkCitations: boolean,
): string {
  const h = crypto.createHash("sha256");
  h.update("v1\n");
  h.update(linkCitations ? "link\n" : "nolink\n");
  for (const t of tokens) {
    h.update(t.raw);
    h.update("\0");
  }
  const mtimes = bibFilesMtime(bibFiles);
  for (let i = 0; i < bibFiles.length; i++) {
    h.update(bibFiles[i]);
    h.update(":");
    h.update(String(mtimes[i]));
    h.update("\0");
  }
  if (cslFile) {
    h.update("csl:");
    h.update(cslFile);
    h.update(":");
    try {
      h.update(String(fs.statSync(cslFile).mtimeMs));
    } catch {
      h.update("0");
    }
  }
  return h.digest("hex").slice(0, 24);
}

function cacheDirFor(projectRoot: string): string {
  const dir = path.join(projectRoot, ".inkwell", ".cache", "preview-cites");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function readCache(
  projectRoot: string,
  key: string,
): PandocCacheEntry | undefined {
  const file = path.join(cacheDirFor(projectRoot), `${key}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as PandocCacheEntry;
  } catch {
    return undefined;
  }
}

function writeCache(
  projectRoot: string,
  key: string,
  entry: PandocCacheEntry,
): void {
  const file = path.join(cacheDirFor(projectRoot), `${key}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(entry), "utf-8");
  } catch {}
}

interface PandocCacheEntry {
  replacements: Array<{ raw: string; html: string }>;
  referencesHtml: string;
  resolved: string[];
  missing: string[];
}

// ── Path A: pandoc --citeproc ─────────────────────────────────────────

let _pandocPath: string | undefined;
let _pandocProbed = false;

function resolvePandoc(): string | undefined {
  if (_pandocProbed) return _pandocPath;
  _pandocProbed = true;
  const resolved = findBinaryViaShell("pandoc");
  if (resolved) {
    _pandocPath = resolved;
  }
  return _pandocPath;
}

async function renderWithPandoc(
  tokens: CitationToken[],
  bibFiles: string[],
  cslFile: string | undefined,
  linkCitations: boolean,
): Promise<PandocCacheEntry | undefined> {
  const pandoc = resolvePandoc();
  if (!pandoc) return undefined;

  // Build a minimal markdown doc: one line per citation (with a unique
  // sentinel we can split on), plus a References container at the end.
  // We run pandoc with --citeproc and parse the HTML output.
  const lines: string[] = [];
  lines.push("---");
  lines.push("bibliography:");
  for (const b of bibFiles) {
    lines.push(`  - ${JSON.stringify(b)}`);
  }
  if (cslFile) {
    lines.push(`csl: ${JSON.stringify(cslFile)}`);
  }
  lines.push(`link-citations: ${linkCitations ? "true" : "false"}`);
  lines.push("suppress-bibliography: false");
  lines.push("reference-section-title: __INKWELL_REFS__");
  lines.push("---");
  lines.push("");

  for (let i = 0; i < tokens.length; i++) {
    lines.push(`<!--INKWELL_CITE_${i}-->`);
    lines.push(tokens[i].full);
    lines.push(`<!--INKWELL_CITE_${i}_END-->`);
    lines.push("");
  }

  const input = lines.join("\n");

  const stdout = await runPandoc(
    pandoc,
    [
      "--from=markdown",
      "--to=html5",
      "--citeproc",
      "--wrap=none",
      "--no-highlight",
    ],
    input,
    15_000,
  );
  if (!stdout) return undefined;

  const replacements: Array<{ raw: string; html: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const startMarker = `<!--INKWELL_CITE_${i}-->`;
    const endMarker = `<!--INKWELL_CITE_${i}_END-->`;
    const si = stdout.indexOf(startMarker);
    const ei = stdout.indexOf(endMarker);
    if (si === -1 || ei === -1) continue;
    let chunk = stdout.slice(si + startMarker.length, ei).trim();
    // Pandoc wraps each paragraph in <p>...</p>, and our markers sit at
    // paragraph edges — so the <p> tags may straddle the markers. Strip
    // any leading <p ...> and trailing </p> that got included.
    chunk = chunk.replace(/^<p\b[^>]*>/, "");
    chunk = chunk.replace(/<\/p>\s*$/, "");
    chunk = chunk.trim();
    replacements.push({ raw: tokens[i].full, html: chunk });
  }

  const refsHtml = extractReferencesHtml(stdout);
  const { resolved, missing } = classifyCitations(replacements);

  return {
    replacements,
    referencesHtml: refsHtml,
    resolved,
    missing,
  };
}

function extractReferencesHtml(pandocHtml: string): string {
  // Pandoc emits a <div id="refs" ...> block containing nested
  // <div class="csl-entry"> children, so we can't use a lazy regex —
  // it would stop at the first inner </div>. Walk balanced <div>s.
  const openRe = /<div[^>]*id="refs"[^>]*>/;
  const open = pandocHtml.match(openRe);
  if (!open || open.index === undefined) return "";
  const start = open.index + open[0].length;

  const tagRe = /<\/?div\b[^>]*>/g;
  tagRe.lastIndex = start;
  let depth = 1;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(pandocHtml)) !== null) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) {
        end = m.index;
        break;
      }
    } else {
      depth++;
    }
  }
  if (end === -1) return "";

  let body = pandocHtml.slice(start, end);
  // Re-wrap the whole thing so consumers get a single top-level container
  // with the same classes pandoc used.
  body = body.replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/g, "").trim();
  return body;
}

function classifyCitations(
  replacements: Array<{ raw: string; html: string }>,
): { resolved: string[]; missing: string[] } {
  const resolved = new Set<string>();
  const missing = new Set<string>();
  for (const r of replacements) {
    const re = /@([\w:./-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.raw)) !== null) {
      const key = m[1];
      if (/citation-missing/.test(r.html) || /\?\?\?/.test(r.html)) {
        missing.add(key);
      } else {
        resolved.add(key);
      }
    }
  }
  return { resolved: [...resolved], missing: [...missing] };
}

// ── Path B: fallback .bib parser ──────────────────────────────────────

interface BibEntry {
  key: string;
  type: string;
  fields: Map<string, string>;
}

export function parseBibFile(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const entryRe = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(text)) !== null) {
    const type = m[1].toLowerCase();
    const key = m[2];
    if (type === "comment" || type === "preamble" || type === "string") continue;

    const bodyStart = m.index + m[0].length;
    const body = extractBalanced(text, bodyStart);
    if (!body) continue;

    const fields = new Map<string, string>();
    const fieldRe = /(\w+)\s*=\s*/g;
    fieldRe.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body)) !== null) {
      const name = fm[1].toLowerCase();
      const valueStart = fm.index + fm[0].length;
      const value = readFieldValue(body, valueStart);
      if (value !== undefined) {
        fields.set(name, cleanBibValue(value));
      }
    }

    entries.push({ key, type, fields });
  }
  return entries;
}

function extractBalanced(text: string, start: number): string | undefined {
  let depth = 1;
  let i = start;
  let inQuotes = false;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (!inQuotes) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === '"') inQuotes = true;
    } else {
      if (ch === '"') inQuotes = false;
    }
    i++;
  }
  if (depth !== 0) return undefined;
  return text.slice(start, i - 1);
}

function readFieldValue(body: string, start: number): string | undefined {
  let i = start;
  while (i < body.length && /\s/.test(body[i])) i++;
  if (i >= body.length) return undefined;
  const ch = body[i];
  if (ch === "{") {
    let depth = 1;
    let j = i + 1;
    while (j < body.length && depth > 0) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}") depth--;
      if (depth === 0) break;
      j++;
    }
    return body.slice(i + 1, j);
  }
  if (ch === '"') {
    let j = i + 1;
    while (j < body.length && body[j] !== '"') {
      if (body[j] === "\\") j++;
      j++;
    }
    return body.slice(i + 1, j);
  }
  // Bare value: until comma or newline.
  let j = i;
  while (j < body.length && body[j] !== "," && body[j] !== "\n") j++;
  return body.slice(i, j).trim();
}

function cleanBibValue(v: string): string {
  let s = v.replace(/\s+/g, " ").trim();
  s = s.replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\\$/g, "$");
  s = s.replace(/\\textit\{([^}]*)\}/g, "<em>$1</em>");
  s = s.replace(/\\textbf\{([^}]*)\}/g, "<strong>$1</strong>");
  s = s.replace(/\\emph\{([^}]*)\}/g, "<em>$1</em>");
  s = s.replace(/--+/g, "\u2013");
  // Strip leftover braces used to protect capitalization.
  s = s.replace(/\{([^{}]*)\}/g, "$1");
  return s;
}

function loadBibEntries(bibFiles: string[]): Map<string, BibEntry> {
  const map = new Map<string, BibEntry>();
  for (const f of bibFiles) {
    try {
      const text = fs.readFileSync(f, "utf-8");
      for (const e of parseBibFile(text)) {
        if (!map.has(e.key)) map.set(e.key, e);
      }
    } catch {}
  }
  return map;
}

function authorSurname(authorField: string): string {
  // Bib authors are joined by " and ". First author surname is what we cite.
  const first = authorField.split(/\s+and\s+/i)[0] || authorField;
  if (first.includes(",")) {
    return first.split(",")[0].trim();
  }
  const parts = first.trim().split(/\s+/);
  return parts[parts.length - 1] || first;
}

function formatAuthorList(authorField: string): string {
  const authors = authorField.split(/\s+and\s+/i).map((a) => {
    a = a.trim();
    if (a.includes(",")) {
      const [last, rest] = a.split(",", 2);
      return `${last.trim()}, ${rest.trim()}`;
    }
    const parts = a.split(/\s+/);
    const last = parts.pop() || a;
    return `${last}, ${parts.join(" ")}`.trim();
  });
  if (authors.length === 0) return "";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
  return authors.slice(0, -1).join(", ") + ", and " + authors[authors.length - 1];
}

function entryAuthorYearLabel(entry: BibEntry): { author: string; year: string } {
  const authorField = entry.fields.get("author") || entry.fields.get("editor") || "Anon.";
  const year = entry.fields.get("year") || entry.fields.get("date") || "n.d.";
  const authors = authorField.split(/\s+and\s+/i);
  let author: string;
  if (authors.length === 1) {
    author = authorSurname(authors[0]);
  } else if (authors.length === 2) {
    author = `${authorSurname(authors[0])} and ${authorSurname(authors[1])}`;
  } else {
    author = `${authorSurname(authors[0])} et al.`;
  }
  return { author, year: String(year).match(/\d{4}/)?.[0] || String(year) };
}

function renderInlineCitationFallback(
  token: CitationToken,
  entries: Map<string, BibEntry>,
  linkCitations: boolean,
): { html: string; resolved: string[]; missing: string[] } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const pieces: string[] = [];

  for (let i = 0; i < token.keys.length; i++) {
    const key = token.keys[i];
    const suppress = token.suppressAuthor[i];
    const entry = entries.get(key);
    if (!entry) {
      missing.push(key);
      pieces.push(`<span class="citation-missing">@${escapeHtmlCit(key)}?</span>`);
      continue;
    }
    resolved.push(key);
    const { author, year } = entryAuthorYearLabel(entry);
    const text = suppress ? year : `${author}, ${year}`;
    const hrefOpen = linkCitations ? `<a href="#ref-${escapeAttr(key)}">` : "";
    const hrefClose = linkCitations ? `</a>` : "";
    pieces.push(`${hrefOpen}${escapeHtmlCit(text)}${hrefClose}`);
  }

  const joined = pieces.join("; ");
  const html = `<span class="citation" data-cites="${token.keys.map(escapeAttr).join(" ")}">[${joined}]</span>`;
  return { html, resolved, missing };
}

function renderReferenceEntryFallback(entry: BibEntry): string {
  const fields = entry.fields;
  const author = fields.get("author") ? formatAuthorList(fields.get("author")!) : "";
  const year = fields.get("year") || fields.get("date") || "n.d.";
  const title = fields.get("title") || "";
  const journal = fields.get("journal") || fields.get("booktitle") || "";
  const volume = fields.get("volume");
  const number = fields.get("number") || fields.get("issue");
  const pages = fields.get("pages");
  const publisher = fields.get("publisher");
  const doi = fields.get("doi");
  const url = fields.get("url");

  const parts: string[] = [];
  if (author) parts.push(escapeHtmlCit(author) + ".");
  parts.push(`(${escapeHtmlCit(String(year))}).`);
  if (title) parts.push(`${escapeHtmlCit(title)}.`);
  if (journal) {
    let journalPart = `<em>${escapeHtmlCit(journal)}</em>`;
    if (volume) journalPart += `, ${escapeHtmlCit(volume)}`;
    if (number) journalPart += `(${escapeHtmlCit(number)})`;
    if (pages) journalPart += `, ${escapeHtmlCit(pages)}`;
    parts.push(journalPart + ".");
  } else if (publisher) {
    parts.push(`${escapeHtmlCit(publisher)}.`);
  }
  if (doi) {
    parts.push(
      `<a href="https://doi.org/${encodeURI(doi)}">https://doi.org/${escapeHtmlCit(doi)}</a>`,
    );
  } else if (url) {
    parts.push(`<a href="${escapeAttr(url)}">${escapeHtmlCit(url)}</a>`);
  }

  return parts.join(" ");
}

function renderReferencesFallback(
  entries: Map<string, BibEntry>,
  cited: Set<string>,
): string {
  const list: BibEntry[] = [];
  for (const key of cited) {
    const e = entries.get(key);
    if (e) list.push(e);
  }
  list.sort((a, b) => {
    const au = (a.fields.get("author") || a.fields.get("editor") || "").toLowerCase();
    const bu = (b.fields.get("author") || b.fields.get("editor") || "").toLowerCase();
    return authorSurname(au).localeCompare(authorSurname(bu));
  });

  if (!list.length) return "";

  const items = list.map((e) => {
    const body = renderReferenceEntryFallback(e);
    return `<div id="ref-${escapeAttr(e.key)}" class="csl-entry">${body}</div>`;
  });

  return `<div id="refs" class="references csl-bib-body">${items.join("\n")}</div>`;
}

async function renderWithFallback(
  tokens: CitationToken[],
  bibFiles: string[],
  linkCitations: boolean,
): Promise<PandocCacheEntry> {
  const entries = loadBibEntries(bibFiles);
  const replacements: Array<{ raw: string; html: string }> = [];
  const resolved = new Set<string>();
  const missing = new Set<string>();

  for (const t of tokens) {
    const r = renderInlineCitationFallback(t, entries, linkCitations);
    replacements.push({ raw: t.full, html: r.html });
    for (const k of r.resolved) resolved.add(k);
    for (const k of r.missing) missing.add(k);
  }

  const refsHtml = renderReferencesFallback(entries, resolved);
  return {
    replacements,
    referencesHtml: refsHtml,
    resolved: [...resolved],
    missing: [...missing],
  };
}

// ── Public entry point ────────────────────────────────────────────────

export async function renderCitations(
  markdown: string,
  opts: CitationOptions,
): Promise<CitationRenderResult> {
  const tokens = extractCitations(markdown);

  // Resolve candidate .bib files. Frontmatter wins (may be absolute or
  // relative to the document directory); otherwise discover via config.
  const docDir = path.dirname(opts.sourceFile);
  const bibFiles: string[] = [];
  const seen = new Set<string>();

  const addBib = (p: string): void => {
    let resolved = p;
    if (!path.isAbsolute(resolved)) {
      const fromDoc = path.resolve(docDir, resolved);
      const fromRoot = path.resolve(opts.projectRoot, resolved);
      if (fs.existsSync(fromDoc)) resolved = fromDoc;
      else if (fs.existsSync(fromRoot)) resolved = fromRoot;
      else resolved = fromDoc;
    }
    if (!seen.has(resolved) && fs.existsSync(resolved)) {
      seen.add(resolved);
      bibFiles.push(resolved);
    }
  };

  if (opts.bibliography?.length) {
    for (const b of opts.bibliography) addBib(b);
  }
  if (!bibFiles.length) {
    for (const b of findBibFiles(opts.projectRoot)) addBib(b);
  }

  if (!tokens.length) {
    return {
      body: markdown,
      resolvedKeys: new Set(),
      missingKeys: new Set(),
      engine: "none",
    };
  }

  let cslFile: string | undefined;
  if (opts.csl) {
    cslFile = findCslFile(opts.projectRoot, opts.csl);
  }

  const linkCitations = opts.linkCitations !== false;

  const key = cacheKey(tokens, bibFiles, cslFile, linkCitations);
  let cached = readCache(opts.projectRoot, key);
  let engine: CitationRenderResult["engine"] = "none";

  if (!cached) {
    cached = await renderWithPandoc(tokens, bibFiles, cslFile, linkCitations);
    if (cached) {
      engine = "pandoc";
    } else if (bibFiles.length) {
      cached = await renderWithFallback(tokens, bibFiles, linkCitations);
      engine = "fallback";
    }
    if (cached) {
      writeCache(opts.projectRoot, key, cached);
    }
  } else {
    // Guess engine from the payload shape: pandoc CSL output includes
    // csl-entry or citation-missing classes.
    engine = cached.referencesHtml.includes("csl-entry") ? "pandoc" : "fallback";
  }

  if (!cached) {
    // No bib and pandoc unavailable — keep cosmetic fallback.
    return {
      body: applyCosmeticFallback(markdown, tokens),
      resolvedKeys: new Set(),
      missingKeys: new Set(tokens.flatMap((t) => t.keys)),
      engine: "none",
    };
  }

  let body = markdown;
  for (const r of cached.replacements) {
    const idx = body.indexOf(r.raw);
    if (idx !== -1) {
      body = body.slice(0, idx) + r.html + body.slice(idx + r.raw.length);
    }
  }

  const refsHeading = opts.referencesHeading || "References";
  let referencesHtml: string | undefined;
  if (cached.referencesHtml && cached.referencesHtml.trim()) {
    referencesHtml = `<section class="references-section"><h2 class="references-heading">${escapeHtmlCit(refsHeading)}</h2>${cached.referencesHtml}</section>`;
  }

  return {
    body,
    referencesHtml,
    resolvedKeys: new Set(cached.resolved),
    missingKeys: new Set(cached.missing),
    engine,
  };
}

function applyCosmeticFallback(markdown: string, tokens: CitationToken[]): string {
  let body = markdown;
  for (const t of tokens) {
    const parts = t.keys.map((k) => escapeHtmlCit(k));
    const span = `<span class="citation citation-missing">[${parts.join("; ")}]</span>`;
    const idx = body.indexOf(t.full);
    if (idx !== -1) {
      body = body.slice(0, idx) + span + body.slice(idx + t.full.length);
    }
  }
  return body;
}

function escapeHtmlCit(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtmlCit(s).replace(/'/g, "&#39;");
}

export { getInkwellProjectRoot };
