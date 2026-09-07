import { isAlias, isMap, isScalar, parseDocument, stringify } from "yaml";
import { DocumentConfig, parseDocumentFrontmatter, resolveDocumentConfig, SizeValue, sizeToString, TypographyConfig } from "./document-config";

export type DocumentStyleKey = `typography.${keyof TypographyConfig}`;
export type DocumentStyleValue = string | number;
export interface DocumentStyleChange { key: DocumentStyleKey; value: DocumentStyleValue }
export interface StyleTextEdit { start: number; end: number; replacement: string; before: string; after: string }
export interface ManifestStyleEdit { before: string; after: string }
export interface DocumentStyleControl {
  key: DocumentStyleKey; label: string; prompt: string; value: string; locked: boolean; reason?: string;
  allowed?: readonly (string | number | boolean)[];
}

const fields: ReadonlyArray<{ key: DocumentStyleKey; label: string; prompt: string }> = [
  { key: "typography.bodyFont", label: "Body font family", prompt: "Font family, for example TeX Gyre Pagella" },
  { key: "typography.bodySize", label: "Body point size", prompt: "Body size in points, for example 11pt" },
  { key: "typography.lineSpacing", label: "Line spacing", prompt: "Line-spacing multiplier, for example 1.4" },
  { key: "typography.headingFont", label: "Heading font family", prompt: "Font family for document headings" },
  { key: "typography.headingWeight", label: "Heading weight", prompt: "Heading font weight supported by this template" },
  { key: "typography.headingScale", label: "Heading scale", prompt: "Heading-size multiplier, for example 1.2" },
  { key: "typography.headingColor", label: "Heading color", prompt: "Heading color, for example #234567" },
  { key: "typography.codeSize", label: "Code font size", prompt: "Code size with units or a named LaTeX size, for example 10pt or small" },
  { key: "typography.captionSize", label: "Caption font size", prompt: "Caption size with units or a named LaTeX size" },
  { key: "typography.tableSize", label: "Table font size", prompt: "Table size with units or a named LaTeX size" },
  { key: "typography.referenceSize", label: "Reference font size", prompt: "Reference size with units or a named LaTeX size" },
  { key: "typography.sansFont", label: "Sans-serif font family", prompt: "Sans-serif font family supported by this engine" },
  { key: "typography.monoFont", label: "Monospace font family", prompt: "Monospace font family supported by this engine" },
];
const knownKeys = new Set(fields.map(field => field.key));
const mapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fieldName = (key: DocumentStyleKey): keyof TypographyConfig => key.slice("typography.".length) as keyof TypographyConfig;
function printable(value: unknown): string {
  if (mapping(value) && "unit" in value && "value" in value) return sizeToString(value as unknown as SizeValue);
  return value === undefined ? "Template-defined" : String(value);
}

export function documentStyleControls(config: DocumentConfig): DocumentStyleControl[] {
  return fields.map(field => {
    const capability = config.capabilities.options[field.key];
    const locked = capability?.support !== "supported";
    const value = config.typography[fieldName(field.key)] ?? capability?.value;
    return { ...field, value: value === undefined && capability?.valueLabel ? capability.valueLabel : printable(value), locked,
      reason: locked ? capability?.reason || `This option is locked by ${config.capabilities.name}.` : undefined,
      allowed: capability?.allowed };
  });
}

/** Use the same typed parser and capability checks as preview and compilation. */
export function validateDocumentStyleValue(config: DocumentConfig, key: DocumentStyleKey, raw: DocumentStyleValue): DocumentStyleChange {
  if (!knownKeys.has(key)) throw new Error("Unknown document style setting.");
  const control = documentStyleControls(config).find(field => field.key === key)!;
  if (control.locked) throw new Error(`${control.label} is locked by ${config.capabilities.name} at ${control.value}. ${control.reason}`);
  if (typeof raw !== "string" && typeof raw !== "number") throw new Error("Choose a text or numeric style value.");
  const checked = resolveDocumentConfig({
    text: `---\n${stringify({ typography: { [fieldName(key)]: raw } })}---\n`,
    manifest: { template: config.template }, templateCapabilities: config.capabilities,
  });
  const issue = checked.diagnostics.find(item => item.key === key && (item.severity === "error" || item.code === "template-capability"));
  if (issue) throw new Error(issue.message);
  if (checked.deferredBindings.some(item => item.key === key)) throw new Error("Enter a concrete style value; run-variable bindings can be edited directly in frontmatter.");
  const value = checked.typography[fieldName(key)];
  if (value === undefined) throw new Error("Enter a supported document style value.");
  return { key, value: typeof value === "number" ? value : printable(value) };
}

function checkedChanges(config: DocumentConfig, changes: readonly DocumentStyleChange[]): DocumentStyleChange[] {
  if (!changes.length) throw new Error("Choose a document style setting first.");
  if (new Set(changes.map(change => change.key)).size !== changes.length) throw new Error("A style edit cannot contain duplicate settings.");
  return changes.map(change => validateDocumentStyleValue(config, change.key, change.value));
}

/** The body, delimiters and BOM are outside the YAML replacement range. */
export function planDocumentStyleEdit(text: string, changes: readonly DocumentStyleChange[], config: DocumentConfig): StyleTextEdit {
  const parsed = parseDocumentFrontmatter(text, config.sourcePath);
  if (parsed.diagnostics.some(item => item.severity === "error")) throw new Error("Repair the document's YAML frontmatter before configuring its style.");
  const checked = checkedChanges(config, changes);
  const yaml = parseDocument(parsed.rawYaml, { keepSourceTokens: true, uniqueKeys: true });
  if (yaml.errors.length || (yaml.contents !== null && !isMap(yaml.contents))) throw new Error("Document frontmatter must be a valid YAML mapping.");
  for (const change of checked) {
    const parts = yaml.has(change.key) ? [change.key] : ["typography", fieldName(change.key)];
    const parent = yaml.get("typography", true);
    const previous = yaml.getIn(parts, true);
    // Do not change unknown metadata through an alias to the edited value.
    if (isScalar(previous) && previous.anchor) throw new Error("This style value defines a YAML anchor. Edit the anchor directly before configuring this setting.");
    if (parts.length > 1 && (isAlias(parent) || (isMap(parent) && parent.anchor))) {
      yaml.set(change.key, change.value); // Canonical dotted spelling safely shadows the shared map.
    } else {
      if (parts.length > 1 && parent !== undefined && !isMap(parent)) throw new Error("The typography section must be a YAML mapping. Its existing value was preserved.");
      yaml.setIn(parts, change.value);
    }
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const raw = yaml.toString({ lineWidth: 0 }).replace(/\r?\n/g, eol);
  const opening = text.match(/^\uFEFF?---[ \t]*\r?\n/);
  const start = parsed.hasFrontmatter ? opening![0].length : text.startsWith("\uFEFF") ? 1 : 0;
  const end = parsed.hasFrontmatter ? start + parsed.rawYaml.length : start;
  const replacement = parsed.hasFrontmatter ? raw : `---${eol}${raw}---${eol}`;
  return { start, end, replacement, before: text, after: text.slice(0, start) + replacement + text.slice(end) };
}

export class MalformedStyleManifestError extends Error {}
export function parseStyleManifest(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new MalformedStyleManifestError("The project manifest is malformed JSON."); }
  if (!mapping(value)) throw new MalformedStyleManifestError("The project manifest must be a JSON object.");
  if (value.defaults !== undefined && !mapping(value.defaults)) throw new MalformedStyleManifestError("Project defaults must be a JSON object.");
  const defaults = value.defaults as Record<string, unknown> | undefined;
  if (defaults?.typography !== undefined && !mapping(defaults.typography)) throw new MalformedStyleManifestError("Project typography defaults must be a JSON object.");
  return value;
}

export function planManifestStyleEdit(text: string, changes: readonly DocumentStyleChange[], config: DocumentConfig): ManifestStyleEdit {
  const manifest = parseStyleManifest(text);
  const checked = checkedChanges(config, changes);
  const defaults = (manifest.defaults ??= {}) as Record<string, unknown>;
  for (const change of checked) {
    if (Object.hasOwn(defaults, change.key)) defaults[change.key] = change.value;
    else ((defaults.typography ??= {}) as Record<string, unknown>)[fieldName(change.key)] = change.value;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/\r?\n([ \t]+)"/)?.[1] || "  ";
  const trailing = /\r?\n$/.test(text) ? eol : "";
  return { before: text, after: JSON.stringify(manifest, null, indent).replace(/\n/g, eol) + trailing };
}
