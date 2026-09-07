import { createHash } from "node:crypto";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { constrainTypographyCapabilities, getTemplateCapabilities, TemplateCapabilities } from "./template-capabilities";
import { normalizeFontFamily, normalizeHeadingWeight, normalizeTypographyColor, sizeInPoints } from "./style-model";

import { TABLE_ATTRIBUTE_SCHEMA, parseTableColor, parseTableAlignment, parseTableWidth, parseTableWeight, TableAlignment } from "./table-values";

export type Metadata = Record<string, unknown>;
export type ConfigSource = "builtin" | "template" | "editor" | "defaults" | "project" | "document" | "block";
export interface SourceLocation { sourcePath: string; line: number; column: number }
export interface ConfigDiagnostic extends SourceLocation {
  code: string;
  message: string;
  severity: "error" | "warning";
  key?: string;
  value?: unknown;
}
export interface ConfigProvenance extends SourceLocation { source: ConfigSource; key: string }
export interface DeferredConfigBinding extends SourceLocation {
  key: string;
  value: string;
  tokens: string[];
  source: ConfigSource;
  metadataKey: string;
}
export type LatexSize = "tiny" | "scriptsize" | "footnotesize" | "small" | "normalsize" | "large" | "Large" | "LARGE" | "huge" | "Huge";
export type SizeValue = { value: number; unit: "pt" | "px" | "em" | "rem" | "%" } | { value: LatexSize; unit: "latex" };
export interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  rawYaml: string;
  body: string;
  bodyOffset: number;
  metadata: Metadata;
  locations: Record<string, SourceLocation>;
  diagnostics: ConfigDiagnostic[];
}
export interface TypographyConfig {
  bodyFont?: string; bodySize?: SizeValue; lineSpacing?: number; sansFont?: string; monoFont?: string;
  headingFont?: string; headingWeight?: string | number; headingScale?: number; headingColor?: string;
  codeSize?: SizeValue; captionSize?: SizeValue; tableSize?: SizeValue; referenceSize?: SizeValue;
}
export interface TableConfig {
  preset: "booktabs" | "grid" | "plain" | "zebra" | "compact";
  stripe: boolean; density: "normal" | "compact" | "comfortable"; captionPosition: "above" | "below";
  fontSize?: SizeValue;
  headerWeight?: "normal" | "bold"; headerBackground?: string; stripeColor?: string; ruleColor?: string;
  ruleThickness?: SizeValue; paddingHorizontal?: SizeValue; paddingVertical?: SizeValue;
  alignment?: TableAlignment[]; numericAlignment?: "inherit" | TableAlignment;
  width?: string; overflow?: "wrap" | "fit"; captionStyle?: "normal" | "italic";
}
export interface ReferenceConfig {
  bibliography: string[]; csl?: string; scope: "document" | "section"; heading: string; links: boolean;
  hangingIndent: boolean; lineSpacing: number; entrySpacing: number; pageBreak: boolean; nocite: string[];
  fontSize?: SizeValue;
}
export interface RunConfig {
  display: "output" | "both" | "code" | "none";
  pythonEnv?: string; rEnv?: string; nodeEnv?: string; cache: boolean; timeoutSeconds?: number;
  maxConcurrency: number; inputs: string[]; dependsOn: string[];
  file?: string; id?: string; output?: string; caption?: string; label?: string;
}
export interface DocumentConfig {
  template: string;
  capabilities: TemplateCapabilities;
  engine: TemplateCapabilities["engine"];
  columns: 1 | 2;
  typography: TypographyConfig;
  tables: TableConfig;
  references: ReferenceConfig;
  runs: RunConfig;
  /** Effective metadata, including unknown author/template metadata. */
  metadata: Metadata;
  /** Original parsed YAML, never rewritten by this service. */
  documentMetadata: Metadata;
  body: string;
  sourcePath: string;
  provenance: Record<string, ConfigProvenance>;
  diagnostics: ConfigDiagnostic[];
  /** Presentation metadata awaiting successful run-variable substitution. */
  deferredBindings: DeferredConfigBinding[];
  fingerprint: string;
  /** Explicit effective values using legacy Pandoc/Inkwell keys. No injected builtins. */
  compatibility: Metadata;
  parsed: ParsedFrontmatter;
}
export interface ResolveDocumentConfigInput {
  text: string;
  sourcePath?: string;
  manifest?: unknown;
  manifestPath?: string;
  defaultsYaml?: string;
  defaultsPath?: string;
  editorDefaults?: Metadata;
  templateCapabilities?: TemplateCapabilities;
  blockAttributes?: Metadata;
}

function mapping(value: unknown): value is Metadata {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** JSON-compatible copy without prototype setters or recursive YAML aliases. */
function copy(value: unknown, ancestors = new Set<unknown>()): unknown {
  if (!mapping(value) && !Array.isArray(value)) return value;
  if (ancestors.has(value)) throw new Error("Recursive YAML aliases are not supported in document configuration.");
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.map((item) => copy(item, next));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item, next)]));
}

function readYaml(rawYaml: string, sourcePath: string, lineOffset: number): Pick<ParsedFrontmatter, "metadata" | "locations" | "diagnostics"> {
  const lineCounter = new LineCounter();
  const yaml = parseDocument(rawYaml, { lineCounter, uniqueKeys: true, version: "1.2", prettyErrors: false });
  const locations: Record<string, SourceLocation> = {};
  const at = (offset: number): SourceLocation => {
    const position = lineCounter.linePos(offset);
    return { sourcePath, line: position.line + lineOffset, column: position.col };
  };
  const diagnostics: ConfigDiagnostic[] = [...yaml.errors, ...yaml.warnings].map((error) => ({
    ...at(error.pos[0]), code: `yaml-${error.code.toLowerCase()}`, message: error.message,
    severity: yaml.errors.includes(error as (typeof yaml.errors)[number]) ? "error" : "warning",
  }));
  const walk = (node: unknown, prefix: string): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue;
        const key = String(pair.key.value);
        const full = prefix ? `${prefix}.${key}` : key;
        locations[full] = at(pair.key.range?.[0] || 0);
        if (forbidden.has(key)) diagnostics.push({ ...locations[full], code: "unsafe-key", severity: "error", key: full, message: `Configuration key ${key} is reserved.` });
        walk(pair.value, full);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => walk(item, `${prefix}.${index}`));
    }
  };
  walk(yaml.contents, "");
  let metadata: Metadata = {};
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { metadata, locations, diagnostics };
  try {
    const value = yaml.toJS({ maxAliasCount: 100 });
    if (value !== null && !mapping(value)) {
      diagnostics.push({ ...at(0), code: "yaml-root-type", severity: "error", message: "Document metadata must be a YAML mapping of keys to values." });
    } else {
      metadata = value === null ? {} : copy(value) as Metadata;
    }
  } catch (error) {
    diagnostics.push({ ...at(0), code: "yaml-value", severity: "error", message: String(error) });
  }
  return { metadata, locations, diagnostics };
}

/** Only delimiter recognition is textual; all YAML values come from the parser. */
export function parseDocumentFrontmatter(text: string, sourcePath = "<document>"): ParsedFrontmatter {
  const opening = text.match(/^\uFEFF?---[ \t]*\r?\n/);
  if (!opening) return { hasFrontmatter: false, rawYaml: "", body: text, bodyOffset: 0, metadata: {}, locations: {}, diagnostics: [] };
  const start = opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = start;
  const end = closing.exec(text);
  if (!end) return {
    hasFrontmatter: true, rawYaml: text.slice(start), body: text, bodyOffset: 0, metadata: {}, locations: {},
    diagnostics: [{ sourcePath, line: 1, column: 1, code: "yaml-unclosed-frontmatter", severity: "error", message: "Close the YAML frontmatter with a line containing --- or ...." }],
  };
  const rawYaml = text.slice(start, end.index);
  const bodyOffset = end.index + end[0].length;
  return { hasFrontmatter: true, rawYaml, body: text.slice(bodyOffset), bodyOffset, ...readYaml(rawYaml, sourcePath, 1) };
}

export function scalarValue(metadata: Metadata, key: string): string | undefined {
  const value = get(metadata, key);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}
export function listValue(metadata: Metadata, key: string): string[] | undefined {
  const value = get(metadata, key);
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function get(object: Metadata, key: string): unknown {
  if (Object.hasOwn(object, key)) return object[key];
  let cursor: unknown = object;
  for (const part of key.split(".")) {
    if (!mapping(cursor) || !Object.hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}
function put(object: Metadata, key: string, value: unknown): void {
  const parts = key.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    if (forbidden.has(part)) return;
    if (!mapping(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Metadata;
  }
  if (!forbidden.has(parts.at(-1)!)) cursor[parts.at(-1)!] = copy(value);
}
function remove(object: Metadata, key: string): void {
  if (Object.hasOwn(object, key)) delete object[key];
  const parts = key.split(".");
  let cursor: unknown = object;
  for (const part of parts.slice(0, -1)) cursor = mapping(cursor) ? cursor[part] : undefined;
  if (mapping(cursor)) delete cursor[parts.at(-1)!];
}
function merge(...values: Metadata[]): Metadata {
  const result: Metadata = {};
  for (const value of values) for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) continue;
    result[key] = mapping(item) && mapping(result[key]) ? merge(result[key] as Metadata, item) : copy(item);
  }
  return result;
}

const latexSizes = new Set<LatexSize>(["tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge"]);
export function parseSize(value: unknown): SizeValue | undefined {
  if (mapping(value) && Object.hasOwn(value, "value") && Object.hasOwn(value, "unit")) {
    return parseSize(value.unit === "latex" ? value.value : `${String(value.value)}${String(value.unit)}`);
  }
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const raw = String(value).trim().replace(/^\\/, "");
  if (latexSizes.has(raw as LatexSize)) return { value: raw as LatexSize, unit: "latex" };
  const match = raw.match(/^(\d+(?:\.\d+)?)(pt|px|em|rem|%)?$/);
  if (!match || Number(match[1]) <= 0 || !Number.isFinite(Number(match[1]))) return undefined;
  return { value: Number(match[1]), unit: (match[2] || "pt") as "pt" | "px" | "em" | "rem" | "%" };
}
export function sizeToString(size: SizeValue): string {
  return size.unit === "latex" ? size.value : `${size.value}${size.unit}`;
}

type Parser = (value: unknown) => unknown;
interface Field { key: string; aliases: string[]; legacy: string; parse: Parser; description: string; block?: string[] }
const string: Parser = (value) => typeof value === "string" && value.trim() ? value : undefined;
const boolean: Parser = (value) => typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : undefined;
const number = (minimum: number, maximum = Infinity, integer = false): Parser => (value) => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum && (!integer || Number.isInteger(parsed)) ? parsed : undefined;
};
const enumeration = (values: readonly string[]): Parser => (value) => typeof value === "string" && values.includes(value) ? value : undefined;
const strings: Parser = (value) => typeof value === "string" && value.trim() ? [value] : Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()) ? [...value] : undefined;
function field(key: string, legacy: string, aliases: string[], parse: Parser, description: string, block?: string[]): Field {
  return { key, legacy, aliases: [...new Set([legacy, ...aliases, `inkwell.${key}`, key])], parse, description, block };
}
const FIELDS: readonly Field[] = [
  field("template", "template", ["inkwell.template"], string, "a template name"),
  field("engine", "pdf-engine", ["engine"], enumeration(["xelatex", "pdflatex", "lualatex"]), "xelatex, pdflatex, or lualatex"),
  field("columns", "inkwell.columns", ["columns"], number(1, 2, true), "1 or 2"),
  field("document.topLevelDivision", "top-level-division", [], enumeration(["chapter", "part", "section"]), "chapter, part, or section"),
  field("document.paperSize", "papersize", ["paperSize"], string, "a paper-size name"),
  field("document.geometry", "geometry", [], (value) => string(value) ?? strings(value), "a geometry option string or list"),
  field("document.documentClass", "documentclass", [], string, "a document class name"),
  field("document.pageStyle", "pagestyle", [], string, "a page style name"),
  field("document.sectionNumbering", "inkwell.section-numbering", ["section-numbering"], (value) => value === "outline" ? "legal" : value === "off" ? "none" : enumeration(["decimal", "legal", "none"])(value), "decimal, legal, or none"),
  field("presentation.codeBackground", "inkwell.code-bg", ["code-bg"], string, "a code background color"),
  field("presentation.codeBorder", "inkwell.code-border", ["code-border"], boolean, "true or false"),
  field("presentation.codeRounded", "inkwell.code-rounded", ["code-rounded"], boolean, "true or false"),
  field("presentation.legacyHangingIndent", "inkwell.hanging-indent", [], boolean, "true or false"),
  field("presentation.mermaidMaxWidth", "inkwell.mermaid-max-width", [], string, "a CSS length"),
  field("presentation.mermaidMaxHeight", "inkwell.mermaid-max-height", [], string, "a CSS length"),
  field("typography.bodyFont", "mainfont", ["fontFamily", "body-font", "typography.fontFamily", "typography.bodyFontFamily"], normalizeFontFamily, "a font family name without TeX commands or CSS declarations"),
  field("typography.bodySize", "fontsize", ["fontSize", "body-font-size", "typography.fontSize", "typography.bodyFontSize"], parseSize, "a positive size with units or a named LaTeX size"),
  field("typography.lineSpacing", "linestretch", ["lineSpacing", "line-height", "typography.lineHeight"], number(0.1, 10), "a positive line-spacing multiplier"),
  field("typography.sansFont", "sansfont", [], normalizeFontFamily, "a sans-serif font family name"),
  field("typography.monoFont", "monofont", [], normalizeFontFamily, "a monospace font family name"),
  field("typography.headingFont", "inkwell.heading-font", ["heading-font"], normalizeFontFamily, "a heading font family name"),
  field("typography.headingWeight", "inkwell.heading-weight", ["heading-weight"], normalizeHeadingWeight, "normal (400) or bold (700), the weights supported by both preview and PDF"),
  field("typography.headingScale", "inkwell.heading-scale", ["heading-scale"], number(0.1, 4), "a heading-size multiplier from 0.1 to 4"),
  field("typography.headingColor", "inkwell.heading-color", ["heading-color"], normalizeTypographyColor, "a hex color, rgb(red, green, blue), or a standard named color"),
  field("typography.codeSize", "inkwell.code-font-size", ["code-font-size", "typography.codeFontSize"], parseSize, "a font size", ["code-font-size"]),
  field("typography.captionSize", "inkwell.caption-font-size", ["caption-font-size", "typography.captionFontSize"], parseSize, "a font size", ["caption-font-size"]),
  field("typography.tableSize", "inkwell.table-font-size", ["table-font-size", "tables.fontSize", "typography.tableFontSize"], parseSize, "a font size", ["table-font-size"]),
  field("typography.referenceSize", "reference-font-size", ["bibliography-font-size", "inkwell.reference-font-size", "references.fontSize", "typography.referenceFontSize"], parseSize, "a font size"),
  field("tables.preset", "inkwell.tables", ["table-preset", "table-style", "inkwell.table-style", "tables.style"], enumeration(["booktabs", "grid", "plain", "zebra", "compact"]), "booktabs, grid, plain, zebra, or compact", ["tables", "table-style", "table-preset"]),
  field("tables.stripe", "inkwell.table-stripe", ["table-stripe"], boolean, "true or false", ["table-stripe"]),
  field("tables.density", "table-density", ["inkwell.table-density"], enumeration(["normal", "compact", "comfortable"]), "normal, compact, or comfortable", ["table-density"]),
  field("tables.captionPosition", "inkwell.caption-style", ["table-caption-position", "caption-style", "tables.caption-position"], enumeration(["above", "below"]), "above or below", ["caption-style", "table-caption-position"]),
  ...TABLE_ATTRIBUTE_SCHEMA.filter(rule => !["preset", "stripe", "density", "fontSizePt", "captionPosition"].includes(rule.field)).map(rule => {
    const parser = rule.type === "color" ? parseTableColor : rule.type === "weight" ? parseTableWeight
      : rule.type === "alignment" ? parseTableAlignment : rule.type === "width" ? parseTableWidth
      : rule.type === "size" ? (value: unknown) => parseSize(value) || (/^0(?:pt|px|em|rem|%)?$/.test(String(value)) ? { value: 0, unit: "pt" } : undefined)
      : enumeration(rule.values || []);
    return field(rule.configKey, rule.aliases[0], rule.aliases.flatMap(alias => [alias, `inkwell.${alias}`]), parser,
      rule.values?.join(", ") || (rule.type === "size" ? "a nonnegative size with units" : `a table ${rule.type}`), [...rule.aliases].reverse());
  }),
  field("references.bibliography", "bibliography", ["references.paths"], strings, "a bibliography path or a list of paths"),
  field("references.csl", "csl", [], string, "a CSL path"),
  field("references.scope", "bibliography-scope", ["reference-scope", "inkwell.reference-scope"], enumeration(["document", "section"]), "document or section"),
  field("references.heading", "reference-section-title", ["references-heading"], string, "a references heading"),
  field("references.links", "link-citations", ["references.linkCitations"], boolean, "true or false"),
  field("references.hangingIndent", "hanging-indent", ["references.hanging-indent"], boolean, "true or false"),
  field("references.lineSpacing", "reference-line-spacing", [], number(0.1, 10), "a positive line-spacing multiplier"),
  field("references.entrySpacing", "reference-entry-spacing", [], number(0, 20), "a nonnegative entry-spacing value"),
  field("references.pageBreak", "reference-page-break", [], boolean, "true or false"),
  field("references.nocite", "nocite", [], strings, "a citation key or a list of keys"),
  field("runs.display", "inkwell.code-display", ["code-display", "defaultCodeDisplay", "inkwell.defaultCodeDisplay", "runs.defaultDisplay"], enumeration(["output", "both", "code", "none"]), "output, both, code, or none", ["display", "code-display"]),
  field("runs.pythonEnv", "inkwell.python-env", ["python-env"], string, "a Python environment or interpreter path"),
  field("runs.rEnv", "inkwell.r-env", ["r-env"], string, "an R interpreter path"),
  field("runs.nodeEnv", "inkwell.node-env", ["node-env"], string, "a Node interpreter path"),
  field("runs.cache", "inkwell.cache", ["run-cache"], boolean, "true or false", ["cache"]),
  field("runs.timeoutSeconds", "inkwell.run-timeout", ["run-timeout", "runs.timeout"], number(0.001, 86400), "a positive timeout in seconds", ["timeout", "run-timeout"]),
  field("runs.maxConcurrency", "inkwell.run-concurrency", ["run-concurrency"], number(1, 32, true), "an integer from 1 to 32"),
  field("runs.inputs", "inkwell.inputs", ["inputs"], strings, "an input path or list of paths", ["inputs"]),
  field("runs.dependsOn", "inkwell.depends-on", ["depends-on", "runs.depends-on"], strings, "a block ID or list of IDs", ["depends-on"]),
  field("runs.file", "inkwell.run-file", [], string, "a script path", ["file"]),
  field("runs.id", "inkwell.run-id", [], string, "a stable block ID", ["id"]),
  field("runs.output", "inkwell.run-output", [], string, "an output mode", ["output"]),
  field("runs.caption", "inkwell.run-caption", [], string, "an output caption", ["caption"]),
  field("runs.label", "inkwell.run-label", [], string, "an output label", ["label"]),
];

const BUILTIN: Metadata = {
  template: "default", engine: "xelatex", columns: 1,
  typography: { codeSize: "small" },
  tables: { preset: "booktabs", stripe: false, density: "normal", captionPosition: "above" },
  references: { bibliography: [], scope: "document", heading: "References", links: true, hangingIndent: true, lineSpacing: 1, entrySpacing: 0, pageBreak: false, nocite: [] },
  runs: { display: "output", cache: true, maxConcurrency: 2, inputs: [], dependsOn: [] },
};
interface Layer { values: Metadata; source: ConfigSource; sourcePath: string; locations?: Record<string, SourceLocation> }
interface Candidate { value: unknown; provenance: ConfigProvenance; deferred?: boolean }
function bindingTokens(value: unknown): string[] {
  if (typeof value === "string") return [...new Set(value.match(/\{\{\w+\}\}/g) || [])];
  return Array.isArray(value) ? [...new Set(value.flatMap(bindingTokens))] : [];
}
const explicit = (source: ConfigSource) => source !== "builtin" && source !== "template";
function location(layer: Layer, key: string): ConfigProvenance {
  // Pandoc defaults flatten metadata/variables into the same resolver layer.
  // Preserve the location of whichever declaration supplied the flattened key.
  const sourceLocation = layer.locations?.[key] || (layer.source === "defaults"
    ? layer.locations?.[`metadata.${key}`] || layer.locations?.[`variables.${key}`] : undefined);
  return { source: layer.source, key, sourcePath: layer.sourcePath, line: 1, column: 1, ...sourceLocation };
}
function candidates(field: Field, layer: Layer, diagnostics: ConfigDiagnostic[]): Candidate[] {
  const aliases = layer.source === "block" ? field.block || [] : field.aliases;
  const result: Candidate[] = [];
  for (const key of aliases) {
    const raw = get(layer.values, key);
    if (raw === undefined) continue;
    // The modern inkwell.tables mapping shares a legacy scalar key.
    if (field.key === "tables.preset" && key === "inkwell.tables" && mapping(raw)) continue;
    const provenance = location(layer, key);
    if (bindingTokens(raw).length) {
      const executionSetting = field.key.startsWith("runs.") && !["runs.caption", "runs.label"].includes(field.key);
      if (executionSetting || field.key === "template" || field.key === "engine") {
        diagnostics.push({ ...provenance, code: "unresolved-run-binding", severity: "error", key: field.key, value: copy(raw),
          message: `${key} contains an unresolved binding. Execution settings and tool selection must be explicit before a process starts.` });
        continue;
      }
      if (typeof raw === "string") {
        result.push({ value: raw, provenance, deferred: true });
        continue;
      }
    }
    const value = field.parse(raw);
    if (value === undefined) {
      diagnostics.push({ ...provenance, code: "invalid-value", severity: "error", key: field.key, value: copy(raw), message: `${key} must be ${field.description}. Correct this value; the next valid default is used until then.` });
    } else result.push({ value, provenance });
  }
  return result;
}

function validateSections(layer: Layer, diagnostics: ConfigDiagnostic[]): void {
  for (const key of ["typography", "tables", "references", "runs", "inkwell", "inkwell.typography", "inkwell.references", "inkwell.runs"]) {
    const value = get(layer.values, key);
    // Pandoc owns top-level CSL reference arrays in document/defaults metadata.
    // Only mappings at this key are Inkwell reference configuration; the
    // namespaced and canonical project sections still require mappings.
    if (key === "references" && Array.isArray(value) && (layer.source === "document" || layer.source === "defaults")) continue;
    if (value !== undefined && !mapping(value)) diagnostics.push({
      ...location(layer, key), key, code: "config-section-type", severity: "error",
      message: `${key} must be a mapping of configuration options.`,
    });
  }
}

function projectLayers(manifest: unknown, sourcePath: string, diagnostics: ConfigDiagnostic[]): Layer[] {
  if (manifest === undefined) return [];
  if (!mapping(manifest)) {
    diagnostics.push({ sourcePath, line: 1, column: 1, code: "manifest-root-type", severity: "error", message: "The project manifest must be a JSON object." });
    return [];
  }
  const result: Layer[] = [];
  for (const key of ["settings", "documentSettings", "defaults"]) {
    const values = manifest[key];
    if (values === undefined) continue;
    if (!mapping(values)) {
      diagnostics.push({ sourcePath, line: 1, column: 1, code: "manifest-section-type", severity: "error", key, message: `Manifest ${key} must be an object. Existing bytes were not changed.` });
    } else result.push({ values, source: "project", sourcePath });
  }
  if (manifest.template !== undefined) result.push({ values: { template: manifest.template }, source: "project", sourcePath });
  return result;
}

/** Migration helper: canonical direct sections, no capability restrictions or builtins. */
export function normalizeManifestDefaults(manifest: Metadata): { defaults: Metadata; diagnostics: ConfigDiagnostic[] } {
  const diagnostics: ConfigDiagnostic[] = [];
  const layers = projectLayers(manifest, "<manifest>", diagnostics);
  for (const layer of layers) validateSections(layer, diagnostics);
  const defaults = mapping(manifest.defaults) ? copy(manifest.defaults) as Metadata : {};
  for (const field of FIELDS) {
    if (!/^(typography|tables|references|runs)\./.test(field.key)) continue;
    const selected = layers.flatMap((layer) => candidates(field, layer, diagnostics)).at(-1);
    if (selected) put(defaults, field.key, legacyValue(selected.value));
  }
  return { defaults, diagnostics };
}

const viewerKeys = ["preview", "fontScale", "zoom", "selectedTab", "scrollPosition", "pdfFitMode", "inkwell.preview", "inkwell.preview.fontScale", "inkwell.fontScale", "inkwell.zoom"];
function pruneConfigContainers(value: Metadata): void {
  for (const key of ["inkwell.typography", "inkwell.tables", "inkwell.references", "inkwell.runs", "typography", "tables", "references", "runs", "document", "presentation", "inkwell"]) {
    const candidate = get(value, key);
    if (mapping(candidate) && Object.keys(candidate).length === 0) remove(value, key);
  }
}
function authorMetadata(value: Metadata): Metadata {
  const result = copy(value) as Metadata;
  for (const key of viewerKeys) remove(result, key);
  pruneConfigContainers(result);
  return result;
}
function legacyValue(value: unknown): unknown {
  return mapping(value) && Object.hasOwn(value, "unit") && Object.hasOwn(value, "value") ? sizeToString(value as unknown as SizeValue) : value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (mapping(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(`inkwell-document-config-v1\n${stable(value)}`).digest("hex");
}
function resolveFields(layers: Layer[], capabilities: TemplateCapabilities, diagnostics: ConfigDiagnostic[]): { values: Metadata; selected: Record<string, Candidate> } {
  const values: Metadata = {};
  const selected: Record<string, Candidate> = {};
  for (const field of FIELDS) {
    const all = layers.flatMap((layer) => candidates(field, layer, diagnostics));
    let candidate = all.at(-1);
    if (!candidate) continue;
    if (candidate.deferred) {
      // Keep a typed template/builtin fallback for preview while retaining the
      // requested token separately. Capability checks require the injected value.
      selected[field.key] = candidate;
      if (["runs.caption", "runs.label"].includes(field.key)) {
        put(values, field.key, candidate.value);
        continue;
      }
      const fallback = all.filter((entry) => !entry.deferred && !explicit(entry.provenance.source)).at(-1);
      if (fallback) put(values, field.key, fallback.value);
      continue;
    }
    if (field.key === "typography.bodySize") {
      const baseline = parseSize(get(capabilities.defaults as Metadata, "typography.bodySize")) || { value: 11, unit: "pt" };
      const baselinePoints = baseline.unit === "latex" ? 11 : baseline.value;
      const size = candidate.value as SizeValue;
      candidate = { ...candidate, value: { value: size.unit === "latex" && size.value === "normalsize" ? baselinePoints : sizeInPoints(size, baselinePoints, baselinePoints), unit: "pt" } };
    }
    const capability = capabilities.options[field.key];
    if (capability && explicit(candidate.provenance.source)) {
      const allowed = capability.support === "supported" && (!capability.allowed || capability.allowed.includes(legacyValue(candidate.value) as string));
      const baseline = [...all].reverse().find((item) => !explicit(item.provenance.source));
      const lockedValue = capability.value === undefined ? baseline?.value : field.parse(capability.value);
      if (!allowed && stable(candidate.value) !== stable(lockedValue)) {
        diagnostics.push({ ...candidate.provenance, code: "template-capability", severity: "warning", key: field.key, value: legacyValue(candidate.value),
          message: `${field.key} is locked by template ${capabilities.name}. ${capability.reason || `Supported values: ${(capability.allowed || []).join(", ")}. Choose one of these values.`}` });
        candidate = lockedValue === undefined ? undefined : { value: lockedValue, provenance: { source: "template", key: field.key, sourcePath: `<template:${capabilities.id}>`, line: 1, column: 1 } };
      }
    }
    if (candidate) { selected[field.key] = candidate; put(values, field.key, candidate.value); }
  }
  return { values, selected };
}

function resultFrom(
  values: Metadata, selected: Record<string, Candidate>, metadata: Metadata,
  parsed: ParsedFrontmatter, sourcePath: string, capabilities: TemplateCapabilities, diagnostics: ConfigDiagnostic[],
): DocumentConfig {
  const compatibility = authorMetadata(metadata);
  for (const field of FIELDS) {
    for (const alias of field.aliases) {
      if (field.key === "tables.preset" && alias === "inkwell.tables" && mapping(get(compatibility, alias))) continue;
      remove(compatibility, alias);
    }
    const candidate = selected[field.key];
    if (candidate && explicit(candidate.provenance.source)) {
      const target = field.key === "tables.preset" && mapping(get(compatibility, "inkwell.tables")) ? "inkwell.tables.preset" : field.legacy;
      put(compatibility, target, legacyValue(candidate.value));
    }
  }
  pruneConfigContainers(compatibility);
  const typography = values.typography as unknown as TypographyConfig;
  const customScaleOptions = ["mainfontoptions", "sansfontoptions", "monofontoptions"].filter(key => {
    const raw = compatibility[key];
    return (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : []).some(option => /(?:^|,)\s*Scale\s*=/i.test(option));
  });
  if (customScaleOptions.length) {
    const reason = `Custom font scaling in ${customScaleOptions.join(", ")} owns the physical font sizes. Remove Scale= from those options to use typography controls with preview/PDF parity.`;
    capabilities = { ...capabilities, typographyNotice: reason, options: { ...capabilities.options,
      ...Object.fromEntries(Object.keys(capabilities.options).filter(key => key.startsWith("typography.")).map(key => {
        const value = typography[key.slice("typography.".length) as keyof TypographyConfig];
        return [key, { support: "locked" as const, value: value === undefined ? undefined : legacyValue(value), valueLabel: value === undefined ? "Owned by custom font scaling" : `${legacyValue(value)} (custom font scaling)`, reason }];
      })),
    } };
    if (!diagnostics.some(diagnostic => diagnostic.code === "font-scale-parity")) diagnostics.push({
      ...(parsed.locations[customScaleOptions[0]] || { sourcePath, line: 1, column: 1 }), code: "font-scale-parity", key: customScaleOptions[0], severity: "warning", message: reason,
    });
  }
  const tables = { ...values.tables as TableConfig, ...(typography.tableSize ? { fontSize: typography.tableSize } : {}) };
  const references = { ...values.references as ReferenceConfig, ...(typography.referenceSize ? { fontSize: typography.referenceSize } : {}) };
  const normalized = { template: values.template as string, engine: values.engine as TemplateCapabilities["engine"], columns: values.columns as 1 | 2, typography, tables, references, runs: values.runs as unknown as RunConfig };
  const deferredBindings: DeferredConfigBinding[] = Object.entries(selected).filter(([, candidate]) => candidate.deferred).map(([key, candidate]) => ({
    ...candidate.provenance, key, metadataKey: candidate.provenance.key, value: String(candidate.value), tokens: bindingTokens(candidate.value),
  }));
  return {
    ...normalized, capabilities, metadata: copy(compatibility) as Metadata, documentMetadata: parsed.metadata, body: parsed.body, sourcePath,
    provenance: Object.fromEntries(Object.entries(selected).map(([key, candidate]) => [key, candidate.provenance])),
    diagnostics, deferredBindings, fingerprint: fingerprint({ ...normalized, metadata: compatibility, capabilities }), compatibility, parsed,
  };
}

export function resolveDocumentConfig(input: ResolveDocumentConfigInput): DocumentConfig {
  const sourcePath = input.sourcePath || "<document>";
  const parsed = parseDocumentFrontmatter(input.text, sourcePath);
  const diagnostics = [...parsed.diagnostics];
  const layers: Layer[] = [{ values: BUILTIN, source: "builtin", sourcePath: "<builtin>" }];
  if (input.editorDefaults) layers.push({ values: input.editorDefaults, source: "editor", sourcePath: "<editor settings>" });
  if (input.defaultsYaml !== undefined) {
    const defaults = readYaml(input.defaultsYaml, input.defaultsPath || "<defaults.yaml>", 0);
    diagnostics.push(...defaults.diagnostics);
    const yaml = defaults.metadata;
    layers.push({ values: merge(mapping(yaml.variables) ? yaml.variables : {}, mapping(yaml.metadata) ? yaml.metadata : {}, yaml), source: "defaults", sourcePath: input.defaultsPath || "<defaults.yaml>", locations: defaults.locations });
  }
  layers.push(...projectLayers(input.manifest, input.manifestPath || "<manifest>", diagnostics));
  layers.push({ values: parsed.metadata, source: "document", sourcePath, locations: parsed.locations });
  for (const layer of layers) validateSections(layer, diagnostics);
  const templateCandidates = layers.flatMap((layer) => candidates(FIELDS[0], layer, []));
  const template = String(templateCandidates.at(-1)?.value || "default");
  const contextValue = (key: string) => {
    const field = FIELDS.find(field => field.key === key);
    return field ? layers.flatMap(layer => candidates(field, layer, [])).at(-1)?.value : undefined;
  };
  const requestedBodySize = contextValue("typography.bodySize") as SizeValue | undefined;
  const capabilities = constrainTypographyCapabilities(input.templateCapabilities || getTemplateCapabilities(template), {
    documentClass: contextValue("document.documentClass") as string | undefined,
    topLevelDivision: contextValue("document.topLevelDivision") as string | undefined,
    classOptions: layers.map(layer => get(layer.values, "classoption")).filter(value => value !== undefined).at(-1),
    requestedBodySize: requestedBodySize && typeof requestedBodySize === "object" ? sizeInPoints(requestedBodySize, template === "eth-report" ? 12 : 11) : undefined,
  });
  if (capabilities.custom) diagnostics.push({ sourcePath, line: 1, column: 1, code: "unknown-template-capabilities", severity: "warning", key: "template", message: `Template ${template} has no capability metadata. Add capabilities to its template.json before using style controls.` });
  layers.splice(1, 0, { values: capabilities.defaults as Metadata, source: "template", sourcePath: `<template:${capabilities.id}>` });
  if (input.blockAttributes) layers.push({ values: input.blockAttributes, source: "block", sourcePath });
  const { values, selected } = resolveFields(layers, capabilities, diagnostics);
  const metadata = merge(...layers.filter((layer) => explicit(layer.source) && layer.source !== "block").map((layer) => authorMetadata(layer.values)));
  return resultFrom(values, selected, metadata, parsed, sourcePath, capabilities, diagnostics);
}

/** Remove centrally resolved fields while retaining unknown Pandoc/template settings. */
export function stripResolvedConfigFields(metadata: Metadata): Metadata {
  const result = authorMetadata(metadata);
  for (const field of FIELDS) for (const alias of field.aliases) {
    if (field.key === "tables.preset" && alias === "inkwell.tables" && mapping(get(result, alias))) continue;
    remove(result, alias);
  }
  pruneConfigContainers(result);
  return result;
}

/** Apply per-block presentation/run options without losing document provenance. */
export function applyBlockOverrides(config: DocumentConfig, attributes: Metadata): DocumentConfig {
  const diagnostics = [...config.diagnostics];
  const fields = FIELDS.filter((field) => field.block);
  const values: Metadata = { template: config.template, engine: config.engine, columns: config.columns, typography: copy(config.typography), tables: copy(config.tables), references: copy(config.references), runs: copy(config.runs) };
  const selected: Record<string, Candidate> = {};
  for (const field of FIELDS) {
    const deferred = config.deferredBindings.find((binding) => binding.key === field.key);
    if (deferred) {
      selected[field.key] = { value: deferred.value, deferred: true, provenance: {
        key: deferred.metadataKey, source: deferred.source, sourcePath: deferred.sourcePath, line: deferred.line, column: deferred.column,
      } };
      continue;
    }
    const value = get(values, field.key) ?? candidates(field, { values: config.compatibility, source: "document", sourcePath: config.sourcePath }, []).at(-1)?.value;
    if (value !== undefined && config.provenance[field.key]) {
      selected[field.key] = { value, provenance: config.provenance[field.key] };
      put(values, field.key, value);
    }
  }
  for (const field of fields) {
    const candidate = candidates(field, { values: attributes, source: "block", sourcePath: config.sourcePath }, diagnostics).at(-1);
    if (!candidate) continue;
    if (candidate.deferred) {
      selected[field.key] = candidate;
      if (["runs.caption", "runs.label"].includes(field.key)) put(values, field.key, candidate.value);
      continue;
    }
    const capability = config.capabilities.options[field.key];
    if (capability && (capability.support !== "supported" || (capability.allowed && !capability.allowed.includes(legacyValue(candidate.value) as string)))) {
      diagnostics.push({ ...candidate.provenance, code: "template-capability", severity: "warning", key: field.key, message: `${field.key} is locked by template ${config.capabilities.name}. ${capability.reason || "Use a supported value."}` });
      continue;
    }
    selected[field.key] = candidate;
    put(values, field.key, candidate.value);
  }
  return resultFrom(values, selected, config.metadata, config.parsed, config.sourcePath, config.capabilities, diagnostics);
}
