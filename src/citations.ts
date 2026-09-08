// Pandoc AST/citeproc is authoritative. The local author-year fallback is explicitly approximate.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getDocumentConfig, getResolvedReferences, getInkwellProjectRoot, ResolvedReferences } from "./config";
import { citationPandocEngine } from "./citation-pandoc";
import { bibliographyService } from "./bibliography-service";

export interface CitationOptions {
  sourceFile: string;
  projectRoot: string;
  resolvedReferences?: ResolvedReferences;
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
  referencesEmbedded?: boolean;
  approximate?: boolean;
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
): FallbackCacheEntry | undefined {
  const file = path.join(cacheDirFor(projectRoot), `${key}.json`);
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf-8")) as FallbackCacheEntry;
    return entry.engine === "fallback" && Array.isArray(entry.replacements) && Array.isArray(entry.resolved) && Array.isArray(entry.missing) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(
  projectRoot: string,
  key: string,
  entry: FallbackCacheEntry,
): void {
  const file = path.join(cacheDirFor(projectRoot), `${key}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(entry), "utf-8");
  } catch {}
}

interface FallbackCacheEntry {
  engine: "fallback";
  replacements: Array<{ raw: string; html: string }>;
  referencesHtml: string;
  resolved: string[];
  missing: string[];
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
      for (const e of new Map(parseBibFile(text).map(entry => [entry.key, entry])).values()) {
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
  const candidateUrl = fields.get("url");
  const url = candidateUrl && /^(?:https?:\/\/|mailto:)/i.test(candidateUrl) ? candidateUrl : undefined;

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
      `<a href="https://doi.org/${escapeAttr(encodeURI(doi))}">https://doi.org/${escapeHtmlCit(doi)}</a>`,
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
): Promise<FallbackCacheEntry> {
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
    engine: "fallback",
    replacements,
    referencesHtml: refsHtml,
    resolved: [...resolved],
    missing: [...missing],
  };
}

// ── Public entry point ────────────────────────────────────────────────

/** Shared path resolution, with a compatibility bridge for existing programmatic callers. */
export function resolveCitationReferences(markdown: string, opts: CitationOptions): ResolvedReferences {
  if (opts.resolvedReferences) return opts.resolvedReferences;
  const config = getDocumentConfig(markdown, opts.sourceFile);
  const overrides: Record<string, unknown> = {};
  if (opts.bibliography !== undefined) overrides.bibliography = opts.bibliography;
  if (opts.csl !== undefined) overrides.csl = opts.csl;
  if (opts.linkCitations !== undefined) overrides["link-citations"] = opts.linkCitations;
  if (opts.referencesHeading !== undefined) overrides["reference-section-title"] = opts.referencesHeading;
  return getResolvedReferences({ ...config,
    references: { ...config.references,
      ...(opts.bibliography === undefined ? {} : { bibliography: opts.bibliography }),
      ...(opts.csl === undefined ? {} : { csl: opts.csl }),
      ...(opts.linkCitations === undefined ? {} : { links: opts.linkCitations }),
      ...(opts.referencesHeading === undefined ? {} : { heading: opts.referencesHeading }),
    },
    provenance: { ...config.provenance, ...Object.fromEntries(Object.keys(overrides).map(key => [
      `references.${({ bibliography: "bibliography", csl: "csl", "link-citations": "links", "reference-section-title": "heading" } as Record<string, string>)[key]}`,
      { source: "document" as const, sourcePath: opts.sourceFile, line: 1, column: 1, key },
    ])) },
    compatibility: { ...config.compatibility, ...overrides },
    documentMetadata: { ...config.documentMetadata, ...overrides },
  }, opts.sourceFile);
}

export async function renderCitations(
  markdown: string,
  opts: CitationOptions,
): Promise<CitationRenderResult> {
  const tokens = extractCitations(markdown);

  const references = resolveCitationReferences(markdown, opts);
  try {
    const full = await citationPandocEngine.render(markdown, references, opts.projectRoot);
    if (full) return full;
  } catch { /* A labelled local approximation remains available after a probe/render failure. */ }
  const bibFiles = [...references.bibliography];
  if (!tokens.length) {
    return {
      body: markdown,
      resolvedKeys: new Set(),
      missingKeys: new Set(),
      engine: "none",
      approximate: /(^|[\s[(])[-]?@[\w]/m.test(markdown) || references.nocite.length > 0,
    };
  }

  const snapshot = await bibliographyService.snapshot(references, "approximate-author-year-v2");
  const key = crypto.createHash("sha256").update(JSON.stringify(["fallback-v2", markdown, snapshot.fingerprint])).digest("hex");
  let cached = readCache(opts.projectRoot, key);
  if (!cached && bibFiles.length) {
    cached = await renderWithFallback(tokens, bibFiles, references.linkCitations);
    writeCache(opts.projectRoot, key, cached);
  }

  if (!cached) {
    // No bib and pandoc unavailable — keep cosmetic fallback.
    return {
      body: applyCosmeticFallback(markdown, tokens),
      resolvedKeys: new Set(),
      missingKeys: new Set(tokens.flatMap((t) => t.keys)),
      engine: "none", approximate: true,
    };
  }

  let body = markdown;
  for (const r of cached.replacements) {
    const idx = body.indexOf(r.raw);
    if (idx !== -1) {
      body = body.slice(0, idx) + r.html + body.slice(idx + r.raw.length);
    }
  }

  const refsHeading = references.referencesHeading || "References";
  let referencesHtml: string | undefined;
  if (cached.referencesHtml && cached.referencesHtml.trim()) {
    referencesHtml = `<section class="references-section"><h2 class="references-heading">${escapeHtmlCit(refsHeading)}</h2>${cached.referencesHtml}</section>`;
  }

  return {
    body,
    referencesHtml,
    resolvedKeys: new Set(cached.resolved),
    missingKeys: new Set(cached.missing),
    engine: cached.engine, approximate: true,
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
