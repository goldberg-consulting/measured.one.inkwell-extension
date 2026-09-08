import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, Scalar, stringify, YAMLMap } from "yaml";
import type { Node, Pair } from "yaml";
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
  return planFrontmatterSettingsEdit(text, checkedChanges(config, changes), config.sourcePath);
}

/** Pandoc metadata keeps its public spelling; new Inkwell options use nested kebab-case. */
function documentSettingPath(key: string): string[] {
  const pandoc: Record<string, string> = {
    "typography.bodySize": "fontsize", "typography.bodyFont": "mainfont",
    "typography.sansFont": "sansfont", "typography.monoFont": "monofont",
    "typography.lineSpacing": "linestretch", "references.bibliography": "bibliography",
    "references.csl": "csl", "references.links": "link-citations",
  };
  if (pandoc[key]) return [pandoc[key]];
  if (key === "typography.tableSize") return ["inkwell", "tables", "font-size"];
  if (key === "typography.referenceSize") return ["inkwell", "references", "font-size"];
  return ["inkwell", ...key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).split(".")];
}

interface SourceEdit { start: number; end: number; replacement: string }
function spliceSource(raw: string, edit: SourceEdit): string {
  return raw.slice(0, edit.start) + edit.replacement + raw.slice(edit.end);
}
function sourceMap(raw: string) {
  const yaml = parseDocument(raw, { keepSourceTokens: true, uniqueKeys: true });
  if (yaml.errors.length || (yaml.contents !== null && !isMap(yaml.contents))) throw new Error("Document frontmatter must be a valid YAML mapping.");
  return yaml;
}
function pairFor(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find(pair => isScalar(pair.key) && pair.key.value === key);
}
function inlineValue(value: unknown, previous?: unknown): string {
  const node = new Scalar(value);
  if (typeof value === "string" && isScalar(previous) && (previous.type === "QUOTE_SINGLE" || previous.type === "QUOTE_DOUBLE")) node.type = previous.type;
  return stringify(Array.isArray(value) || mapping(value) ? value : node, {
    collectionStyle: "flow", lineWidth: 0, blockQuote: false, singleQuote: true,
  }).replace(/\n$/, "");
}
function indentationAt(raw: string, offset: number): string {
  return raw.slice(raw.lastIndexOf("\n", offset - 1) + 1, offset).match(/^ */)?.[0] || "";
}
function commentsIn(token: unknown, start: number, end: number): { offset: number; source: string }[] {
  if (!mapping(token)) return [];
  if (token.type === "comment" && typeof token.offset === "number" && typeof token.source === "string") {
    return token.offset >= start && token.offset < end ? [{ offset: token.offset, source: token.source }] : [];
  }
  return Object.values(token).flatMap(value => Array.isArray(value)
    ? value.flatMap(item => commentsIn(item, start, end)) : commentsIn(value, start, end));
}

/** Replace only a selected value token, retaining its quoting and surrounding CST trivia. */
function valueEdits(raw: string, previous: Node, value: unknown, eol: string): SourceEdit[] {
  if (!previous.range) throw new Error("This YAML setting has no editable source range.");
  if (isScalar(previous) && Object.is(previous.value, value)) return [];
  if (!isAlias(previous) && "anchor" in previous && previous.anchor) throw new Error("This setting defines a YAML anchor. Edit the anchor directly before configuring this setting.");
  if (isSeq(previous) && Array.isArray(value) && value.length > previous.items.length && previous.items.every((item, index) => isScalar(item) && Object.is(item.value, value[index]))) {
    const added = value.slice(previous.items.length).map(item => inlineValue(item));
    if (previous.flow) {
      const last = previous.items.at(-1);
      const start = isNode(last) ? last.range![1] : previous.range[0] + 1;
      return [{ start, end: start, replacement: `${last ? ", " : ""}${added.join(", ")}` }];
    }
    const indent = indentationAt(raw, previous.range[0]);
    const start = previous.range[1];
    return [{ start, end: start, replacement: `${raw[start - 1] === "\n" ? "" : eol}${added.map(item => `${indent}- ${item}`).join(eol)}${eol}` }];
  }
  if (isSeq(previous) && Array.isArray(value) && previous.items.length === value.length && previous.items.every(isNode)) {
    return previous.items.flatMap((item, index) => valueEdits(raw, item as Node, value[index], eol));
  }
  const [start, end] = previous.range;
  let replacement = inlineValue(value, previous);
  const token = previous.srcToken;
  if (token?.type === "block-scalar") {
    // The block's header comment belongs to the setting, so retain its exact
    // spaces/comment/newline while replacing the header and scalar content.
    replacement += token.props.slice(1).map(prop => "source" in prop ? prop.source : "").join("");
  } else if (start === end) {
    if (raw[start - 1] === ":") replacement = ` ${replacement}`;
    if (raw[start] === "#") replacement += " ";
  } else if (isMap(previous) || isSeq(previous)) {
    // A changed collection may remove entries; retain every comment even when
    // its former entry is no longer selected. Unchanged-length scalar lists
    // take the token-by-token path above and preserve their exact formatting.
    const comments = commentsIn(token, start, end).sort((a, b) => a.offset - b.offset);
    const indent = indentationAt(raw, start);
    for (const comment of comments) replacement += `${eol}${indent}${comment.source}`;
    if (comments.length || /\r?\n$/.test(raw.slice(start, end))) replacement += eol;
  }
  return [{ start, end, replacement }];
}

function insertPair(raw: string, map: YAMLMap | null, path: readonly string[], value: unknown, eol: string): SourceEdit {
  if (!map) {
    const branch = path.reduceRight<unknown>((child, key) => ({ [key]: child }), value);
    const replacement = stringify(branch, { lineWidth: 0, blockQuote: false, singleQuote: true }).replace(/\n/g, eol);
    return { start: raw.length, end: raw.length, replacement: `${raw && !raw.endsWith("\n") ? eol : ""}${replacement}` };
  }
  if (map.flow) {
    const branch = path.reduceRight<unknown>((child, key) => ({ [key]: child }), value);
    const entry = inlineValue(branch).slice(1, -1).trim();
    const last = map.items.at(-1);
    // Inserting immediately after the final value also retains any existing
    // trailing comma, spaces, comments, and closing brace byte for byte.
    const at = last && isNode(last.value) ? last.value.range?.[1] : last && isNode(last.key) ? last.key.range?.[1] : undefined;
    const start = at ?? map.range![0] + 1;
    return { start, end: start, replacement: `${last ? ", " : ""}${entry}` };
  }
  const firstKey = map.items.find(pair => isNode(pair.key))?.key as Node | undefined;
  const indent = firstKey?.range ? indentationAt(raw, firstKey.range[0]) : "";
  const branch = path.reduceRight<unknown>((child, key) => ({ [key]: child }), value);
  const rendered = stringify(branch, { lineWidth: 0, blockQuote: false, singleQuote: true });
  const addition = rendered.split("\n").slice(0, -1).map(line => indent + line).join(eol) + eol;
  const start = map.range![1];
  return { start, end: start, replacement: `${start && raw[start - 1] !== "\n" ? eol : ""}${addition}` };
}

/** Source edits never serialize an existing map. Shared maps receive a safe dotted override. */
function writeSetting(raw: string, path: readonly string[], value: unknown, eol: string): string {
  const yaml = sourceMap(raw);
  const root = yaml.contents as YAMLMap | null;
  if (root?.anchor) throw new Error("The frontmatter mapping defines a YAML anchor. Edit its settings directly to preserve shared metadata.");
  const dotted = path.join(".");
  // Exact dotted keys have priority over nested keys in the shared resolver.
  const direct = root && pairFor(root, dotted);
  const effectivePath = direct ? [dotted] : path;
  let current = root;
  for (let index = 0; index < effectivePath.length; index++) {
    const pair = current && pairFor(current, effectivePath[index]);
    if (!pair) return spliceSource(raw, insertPair(raw, current, effectivePath.slice(index), value, eol));
    const previous = pair.value;
    if (index === effectivePath.length - 1) {
      if (!isNode(previous)) throw new Error("This YAML setting has no editable source value.");
      if (!isAlias(previous) && "anchor" in previous && previous.anchor && effectivePath.length > 1) {
        return spliceSource(raw, insertPair(raw, root, [dotted], value, eol));
      }
      return valueEdits(raw, previous, value, eol).sort((a, b) => b.start - a.start).reduce(spliceSource, raw);
    }
    if (!isMap(previous) || previous.anchor) {
      // Do not mutate an alias target, shared map, legacy scalar table preset,
      // or native CSL references sequence merely to add one Inkwell option.
      return spliceSource(raw, insertPair(raw, root, [dotted], value, eol));
    }
    current = previous;
  }
  return raw;
}

/** Shared undoable edit; parse CST for locations, then splice only changed tokens/new keys. */
export function planFrontmatterSettingsEdit(text: string, changes: readonly { key: string; value: unknown }[], sourcePath: string): StyleTextEdit {
  if (!changes.length || new Set(changes.map(change => change.key)).size !== changes.length) throw new Error("Choose distinct document settings to edit.");
  const parsed = parseDocumentFrontmatter(text, sourcePath);
  if (parsed.diagnostics.some(item => item.severity === "error")) throw new Error("Repair the document's YAML frontmatter before configuring its style.");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let raw = parsed.rawYaml;
  for (const change of changes) {
    if (!/^(?:typography|tables|references)\.[a-zA-Z][a-zA-Z0-9]*$/.test(change.key)) throw new Error("Unknown document setting.");
    const canonical = documentSettingPath(change.key);
    // Keep legacy resolver precedence. If an existing stronger spelling shadows
    // a Pandoc key, update that setting too without touching any other metadata.
    const prior = canonical.length === 1 ? resolveDocumentConfig({ text: `---${eol}${raw}---${eol}`, sourcePath }).provenance[change.key] : undefined;
    raw = writeSetting(raw, canonical, change.value, eol);
    if (prior?.source === "document" && prior.key !== canonical.join(".")) raw = writeSetting(raw, prior.key.split("."), change.value, eol);
    sourceMap(raw); // A malformed planned insertion is never handed to the editor.
  }
  const opening = text.match(/^\uFEFF?---[ \t]*\r?\n/);
  const yamlStart = parsed.hasFrontmatter ? opening![0].length : text.startsWith("\uFEFF") ? 1 : 0;
  const yamlEnd = parsed.hasFrontmatter ? yamlStart + parsed.rawYaml.length : yamlStart;
  const inserted = parsed.hasFrontmatter ? raw : `---${eol}${raw}---${eol}`;
  const after = text.slice(0, yamlStart) + inserted + text.slice(yamlEnd);
  // One editor operation remains undoable, with the smallest enclosing range.
  let start = 0;
  while (start < text.length && start < after.length && text[start] === after[start]) start++;
  let end = text.length, afterEnd = after.length;
  while (end > start && afterEnd > start && text[end - 1] === after[afterEnd - 1]) { end--; afterEnd--; }
  return { start, end, replacement: after.slice(start, afterEnd), before: text, after };
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
    const direct = Object.hasOwn(defaults, change.key);
    const proposed = direct ? { ...defaults, [change.key]: change.value }
      : { ...defaults, typography: { ...defaults.typography as Record<string, unknown>, [fieldName(change.key)]: change.value } };
    const resolved = resolveDocumentConfig({ text: "", manifest: { ...manifest, defaults: proposed }, templateCapabilities: config.capabilities });
    if (resolved.provenance[change.key]?.key === change.key) {
      if (direct) defaults[change.key] = change.value;
      else ((defaults.typography ??= {}) as Record<string, unknown>)[fieldName(change.key)] = change.value;
      continue;
    }
    // Preserve weaker aliases when an existing spelling shadows the ordinary
    // project field. The strongest canonical key changes only this setting.
    const canonical = change.key === "typography.tableSize" ? "inkwell.tables.font-size"
      : change.key === "typography.referenceSize" ? "inkwell.references.font-size"
      : `inkwell.${change.key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    if (Object.hasOwn(defaults, canonical)) {
      defaults[canonical] = change.value;
      continue;
    }
    let target: Record<string, unknown> | undefined = defaults;
    const parts = canonical.split(".");
    for (const part of parts.slice(0, -1)) {
      if (target[part] !== undefined && !mapping(target[part])) { target = undefined; break; }
      target = (target[part] ??= {}) as Record<string, unknown>;
    }
    if (target) target[parts.at(-1)!] = change.value;
    else defaults[canonical] = change.value;
  }
  const resolved = resolveDocumentConfig({ text: "", manifest, templateCapabilities: config.capabilities });
  for (const change of checked) {
    if (resolved.deferredBindings.some(binding => binding.key === change.key) || printable(resolved.typography[fieldName(change.key)]) !== String(change.value)) {
      throw new Error(`The project override for ${change.key} could not be applied. Existing settings were preserved.`);
    }
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/\r?\n([ \t]+)"/)?.[1] || "  ";
  const trailing = /\r?\n$/.test(text) ? eol : "";
  return { before: text, after: JSON.stringify(manifest, null, indent).replace(/\n/g, eol) + trailing };
}
