import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { DocumentConfig, ConfigProvenance } from "./document-config";
import { resolveTypography } from "./style-model";

export const BIBLIOGRAPHY_RESOLVER_VERSION = 2;
export interface BibliographyDiagnostic {
  code: string; severity: "error" | "warning"; message: string;
  sourcePath: string; line: number; column: number; key?: string;
  related?: readonly { sourcePath: string; line: number; column: number }[];
}
export interface BibliographySource {
  path: string; source: "declared" | "discovered" | "builtin";
  provenance?: ConfigProvenance;
}
export interface ResolvedReferences {
  readonly projectRoot: string;
  readonly bibliography: readonly string[];
  readonly sources: readonly BibliographySource[];
  readonly csl?: string; readonly cslSource?: BibliographySource;
  readonly scope: "document" | "section";
  readonly linkCitations: boolean; readonly referencesHeading: string;
  readonly hangingIndent: string; readonly lineSpacing: number; readonly entrySpacing: string;
  readonly hangingIndentPt: number; readonly entrySpacingPt: number;
  readonly pageBreak: "auto" | "always" | "never"; readonly fontSizePt: number; readonly nocite: readonly string[];
  readonly fontSupported: boolean;
  readonly inlineReferences: readonly unknown[];
  readonly diagnostics: readonly BibliographyDiagnostic[];
}
export interface BibliographyEntry {
  readonly key: string; readonly type: string; readonly title: string; readonly author: string; readonly year: string;
  readonly sourcePath: string; readonly line: number; readonly column: number;
  readonly offset: number; readonly end: number;
}
export interface BibliographySnapshot extends ResolvedReferences {
  readonly entries: readonly BibliographyEntry[];
  readonly contentHashes: Readonly<Record<string, string>>;
  readonly cslHash?: string; readonly pandocVersion: string; readonly resolverVersion: number;
  readonly fingerprint: string;
}
/** Earlier files win; within one file retain Pandoc's last-definition rule. */
export function preferredBibliographyEntry(entries: readonly BibliographyEntry[]): BibliographyEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) if (entries[index].sourcePath === entries[0].sourcePath) return entries[index];
  return undefined;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const regular = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
export function validateReferencePath(root: string, file: string, creating = false): void {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Reference files must stay inside the project.");
  const actual = fs.realpathSync(creating ? path.dirname(file) : file);
  const realRelative = path.relative(fs.realpathSync(root), actual);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error("Reference paths must not escape through symbolic links.");
  if (!(creating ? fs.statSync(actual).isDirectory() : fs.statSync(actual).isFile())) throw new Error("Choose a regular reference file in the project.");
}
export function discoverBibliographies(root: string): string[] {
  return [root, path.join(root, "references"), path.join(root, ".inkwell", "references")].flatMap(directory => {
    try { return fs.readdirSync(directory).sort().filter(name => /\.bib$/i.test(name)).map(name => path.join(directory, name)).filter(regular); }
    catch { return []; }
  });
}
export function findBibliographyStyle(root: string, name: string): string | undefined {
  for (const directory of [".inkwell/csl", "csl", ".", "references"].map(value => path.resolve(root, value))) {
    for (const candidate of [name, name.endsWith(".csl") ? name : `${name}.csl`]) {
      const file = path.resolve(directory, candidate);
      if (regular(file)) return file;
    }
  }
  return undefined;
}

/** Explicit lists (including []) disable discovery. Earlier files win lookup;
 * bibliographyMetadata reverses backend inputs because Pandoc uses the last file.
 */
export function resolveBibliographyConfiguration(config: DocumentConfig, sourceFile: string, root: string): ResolvedReferences {
  const diagnostics: BibliographyDiagnostic[] = [];
  const declaration = config.provenance["references.bibliography"];
  const contextPath = (file: string, provenance: ConfigProvenance | undefined): string => {
    if (path.isAbsolute(file)) return path.normalize(file);
    const fromDocument = path.resolve(path.dirname(sourceFile), file);
    const fromProject = path.resolve(root, file);
    if (provenance?.source === "document") return regular(fromDocument) || !regular(fromProject) ? fromDocument : fromProject;
    return fromProject;
  };
  const explicitlyDeclared = declaration && !["builtin", "template"].includes(declaration.source);
  const sources: BibliographySource[] = [];
  const seen = new Set<string>();
  const add = (item: BibliographySource) => { if (!seen.has(item.path)) { seen.add(item.path); sources.push(item); } };
  for (const file of config.references.bibliography) add({ path: contextPath(file, declaration), source: "declared", provenance: declaration });
  if (!explicitlyDeclared) for (const file of discoverBibliographies(root)) add({ path: file, source: "discovered" });
  const diagnostic = (source: BibliographySource, code: string, message: string) => diagnostics.push({
    code, severity: "error", message, sourcePath: source.provenance?.sourcePath || sourceFile,
    line: source.provenance?.line || 1, column: source.provenance?.column || 1,
  });
  for (const source of sources) if (!regular(source.path)) diagnostic(source, "bibliography-missing", `Bibliography file is missing: ${source.path}`);
  const cslProvenance = config.provenance["references.csl"];
  const csl = config.references.csl ? contextPath(config.references.csl, cslProvenance) : path.join(__dirname, "..", "csl", "inkwell-numeric.csl");
  const cslSource: BibliographySource = { path: regular(csl) || !config.references.csl ? csl : findBibliographyStyle(root, config.references.csl) || csl,
    source: config.references.csl ? "declared" : "builtin", provenance: cslProvenance };
  if (!regular(cslSource.path)) diagnostic(cslSource, "csl-missing", `CSL style is missing: ${cslSource.path}`);
  const typography = resolveTypography(config), fontSizePt = typography.referenceSizePt;
  const length = (value: string) => {
    const amount = parseFloat(value), unit = value.replace(/^[\d.]+/, "");
    return amount * (unit === "em" ? fontSizePt : unit === "rem" ? typography.bodySizePt : unit === "%" ? fontSizePt / 100 : unit === "px" ? 72.27 / 96 : 1);
  };
  if (fontSizePt > 200) diagnostics.push({ code: "reference-font-size", severity: "error", sourcePath: sourceFile, line: 1, column: 1, message: "Reference font size must not exceed 200pt." });
  return freeze({ projectRoot: root, bibliography: sources.map(source => source.path), sources, csl: cslSource.path, cslSource,
    scope: config.references.scope, linkCitations: config.references.links, referencesHeading: config.references.heading,
    hangingIndent: config.references.hangingIndent, lineSpacing: config.references.lineSpacing,
    entrySpacing: config.references.entrySpacing, pageBreak: config.references.pageBreak,
    hangingIndentPt: length(config.references.hangingIndent), entrySpacingPt: length(config.references.entrySpacing),
    fontSizePt, nocite: [...config.references.nocite],
    fontSupported: config.capabilities.options["typography.referenceSize"]?.support === "supported",
    inlineReferences: Array.isArray(config.compatibility.references) ? [...config.compatibility.references] : [], diagnostics });
}

interface ParsedBibliography { entries: BibliographyEntry[]; diagnostics: BibliographyDiagnostic[] }
const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve));
/** A tolerant authoring index. Pandoc remains the BibTeX/citation rendering authority.
 * Balanced values prevent embedded @, commas, escapes or field names from becoming entries.
 * Parsing yields between entries and while scanning large values.
 */
export async function indexBibtex(text: string, sourcePath: string): Promise<ParsedBibliography> {
  const entries: BibliographyEntry[] = [], diagnostics: BibliographyDiagnostic[] = [];
  let cursor = 0, line = 1, column = 1, sinceYield = 0;
  const advance = () => { if (text[cursor++] === "\n") { line++; column = 1; } else column++; sinceYield++; };
  const tick = async () => { if (sinceYield >= 32768) { sinceYield = 0; await yieldToHost(); } };
  while (cursor < text.length) {
    await tick();
    if (text[cursor] === "%") { while (cursor < text.length && text[cursor] !== "\n") advance(); continue; }
    if (text[cursor] !== "@") { advance(); continue; }
    const offset = cursor, startLine = line, startColumn = column;
    const start = text.slice(cursor).match(/^@([a-zA-Z]+)\s*([{(])/);
    if (!start) { advance(); continue; }
    for (let i = 0; i < start[0].length; i++) advance();
    const type = start[1].toLowerCase(), close = start[2] === "{" ? "}" : ")";
    const bodyStart = cursor;
    let braces = start[2] === "{" ? 1 : 0, quotes = false, escaped = false, closed = false;
    while (cursor < text.length) {
      const ch = text[cursor];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"' && braces === (start[2] === "{" ? 1 : 0)) quotes = !quotes;
      else if (!quotes) {
        if (ch === "{") braces++;
        else if (ch === "}") braces--;
        if ((close === "}" && braces === 0) || (close === ")" && ch === ")" && braces === 0)) { closed = true; break; }
      }
      advance(); await tick();
    }
    const body = text.slice(bodyStart, cursor);
    if (closed) advance();
    if (["comment", "preamble", "string"].includes(type)) continue;
    const key = body.match(/^\s*([^\s,{}()]+)\s*,/)?.[1];
    if (!closed || !key) {
      diagnostics.push({ code: "bibliography-malformed", severity: "error", sourcePath, line: startLine, column: startColumn,
        message: `Malformed BibTeX entry${key ? ` @${key}` : ""}: ${closed ? "expected a citation key followed by a comma" : "unclosed entry"}.`, key });
      continue;
    }
    const fields: Record<string, string> = Object.create(null);
    let position = body.indexOf(",") + 1, malformed = false;
    while (position < body.length) {
      const spacing = body.slice(position).match(/^(?:\s|,|%[^\n]*(?:\n|$))*/)?.[0] || ""; position += spacing.length;
      if (position >= body.length) break;
      const field = body.slice(position).match(/^([a-zA-Z][\w-]*)\s*=\s*/);
      if (!field) { malformed = true; break; }
      position += field[0].length;
      const valueStart = position;
      let depth = 0, quote = false, escape = false;
      while (position < body.length) {
        const ch = body[position];
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"' && depth === 0) quote = !quote;
        else if (!quote) { if (ch === "{") depth++; else if (ch === "}") depth--; else if (ch === "," && depth === 0) break; }
        position++;
        if (position % 32768 === 0) await yieldToHost();
      }
      const value = body.slice(valueStart, position).trim();
      if (!value || depth !== 0 || quote) malformed = true;
      // Hover text is intentionally plain. No TeX, Markdown, links or macros execute.
      fields[field[1].toLowerCase()] = value.replace(/^[{"]|[}"]$/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      if (body[position] === ",") position++;
    }
    if (malformed) diagnostics.push({ code: "bibliography-malformed", severity: "error", sourcePath, line: startLine, column: startColumn, key,
      message: `Malformed fields in @${key}; expected name = value pairs separated by commas.` });
    entries.push({ key, type, title: fields.title || key, author: fields.author || fields.editor || "", year: fields.year || fields.date || "",
      sourcePath, line: startLine, column: startColumn, offset, end: cursor });
    if (entries.length % 64 === 0) await yieldToHost();
  }
  return { entries, diagnostics };
}

interface IndexedFile { signature: string; hash: string; parsed: ParsedBibliography }
export class BibliographyService {
  private readonly files = new Map<string, IndexedFile>();
  private readonly inFlight = new Map<string, Promise<IndexedFile>>();
  private generation = 0;
  invalidate(file?: string): void {
    this.generation++;
    if (file) this.files.delete(path.resolve(file)); else this.files.clear();
  }
  private async read(file: string, bibliography: boolean): Promise<IndexedFile> {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Expected a regular file no larger than 50 MiB.");
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    const cached = this.files.get(file);
    if (cached?.signature === signature) return cached;
    const flightKey = `${this.generation}:${bibliography}:${file}:${signature}`;
    const existing = this.inFlight.get(flightKey); if (existing) return existing;
    const generation = this.generation;
    const pending = (async () => {
      const bytes = await fs.promises.readFile(file), text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("The file is not valid UTF-8.");
      const parsed = bibliography ? await indexBibtex(text, file) : { entries: [], diagnostics: [] };
      const result = { signature, hash: hash(bytes), parsed };
      if (generation === this.generation) this.files.set(file, result);
      return result;
    })();
    this.inFlight.set(flightKey, pending);
    try { return await pending; } finally { this.inFlight.delete(flightKey); }
  }
  async resolve(config: DocumentConfig, sourceFile: string, root: string, pandocVersion = "unavailable"): Promise<BibliographySnapshot> {
    return this.snapshot(resolveBibliographyConfiguration(config, sourceFile, root), pandocVersion);
  }
  async snapshot(resolved: ResolvedReferences, pandocVersion = "unavailable"): Promise<BibliographySnapshot> {
    const diagnostics = [...resolved.diagnostics], entries: BibliographyEntry[] = [], contentHashes: Record<string, string> = {};
    // Preserve declaration order even when file reads/parsers finish out of order.
    const results = await Promise.allSettled(resolved.bibliography.map(async file => { validateReferencePath(resolved.projectRoot, file); return this.read(file, true); }));
    for (let i = 0; i < results.length; i++) {
      const result = results[i], file = resolved.bibliography[i];
      if (result.status === "fulfilled") { entries.push(...result.value.parsed.entries); diagnostics.push(...result.value.parsed.diagnostics); contentHashes[file] = result.value.hash; }
      else if (!diagnostics.some(item => item.code === "bibliography-missing" && item.message.includes(file))) diagnostics.push({
        code: "bibliography-unreadable", severity: "error", sourcePath: file, line: 1, column: 1, message: `Cannot index bibliography: ${String(result.reason)}` });
    }
    const definitions = new Map<string, BibliographyEntry[]>();
    for (const entry of entries) { const group = definitions.get(entry.key) || []; group.push(entry); definitions.set(entry.key, group); }
    for (const [key, group] of definitions) if (group.length > 1) for (const entry of group) diagnostics.push({
      code: "bibliography-duplicate", severity: "warning", key, sourcePath: entry.sourcePath, line: entry.line, column: entry.column,
      message: `Duplicate @${key}; the first file in the resolved order takes precedence (${preferredBibliographyEntry(group)!.sourcePath}:${preferredBibliographyEntry(group)!.line}).`,
      related: group.filter(item => item !== entry).map(item => ({ sourcePath: item.sourcePath, line: item.line, column: item.column })),
    });
    let cslHash: string | undefined;
    if (resolved.csl) try {
      if (resolved.cslSource?.source !== "builtin") validateReferencePath(resolved.projectRoot, resolved.csl);
      cslHash = (await this.read(resolved.csl, false)).hash;
    }
    catch (error) { if (!diagnostics.some(item => item.code === "csl-missing")) diagnostics.push({ code: "csl-unreadable", severity: "error",
      sourcePath: resolved.csl, line: 1, column: 1, message: `Cannot read CSL: ${String(error)}` }); }
    const fingerprint = hash(JSON.stringify({ resolved, contentHashes, cslHash, pandocVersion, resolverVersion: BIBLIOGRAPHY_RESOLVER_VERSION }));
    return freeze({ ...resolved, entries, diagnostics, contentHashes, cslHash, pandocVersion, resolverVersion: BIBLIOGRAPHY_RESOLVER_VERSION, fingerprint });
  }
}
export const bibliographyService = new BibliographyService();

/** Safe typed metadata consumed by the shared Pandoc filters in both outputs. */
export function bibliographyMetadata(references: ResolvedReferences): Record<string, unknown> {
  const options = { heading: references.referencesHeading, hangingIndentPt: references.hangingIndentPt,
    lineSpacing: references.lineSpacing, entrySpacingPt: references.entrySpacingPt, pageBreak: references.pageBreak,
    fontSizePt: references.fontSizePt, fontSupported: references.fontSupported };
  return { bibliography: [...references.bibliography].reverse(), ...(references.csl ? { csl: references.csl } : {}),
    "link-citations": references.linkCitations,
    ...(references.inlineReferences.length ? { references: references.inlineReferences } : {}),
    ...(references.nocite.length ? { nocite: references.nocite.map(key => key.startsWith("@") ? key : `@${key}`).join(", ") } : {}),
    "inkwell-reference-options": "hex:" + Buffer.from(JSON.stringify(options), "utf8").toString("hex"),
  };
}
