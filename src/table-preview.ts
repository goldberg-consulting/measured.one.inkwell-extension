import * as crypto from "crypto";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { decodeTableData, TABLE_DATA_FENCE, TableData } from "./table-data";
import { isNumericTableValue, TableAlignment } from "./table-values";

export interface TablePreviewDiagnostic { code: string; message: string; severity: "info" | "warning" | "error" }
export interface TablePreviewStyle {
  preset: string;
  captionPosition: "above" | "below";
  cssText: string;
  alignment?: readonly TableAlignment[];
  alignmentIsLocal?: boolean;
  numericAlignment?: "inherit" | TableAlignment;
  diagnostics?: readonly TablePreviewDiagnostic[];
}
export type TablePreviewStyleResolver = (attributes: Record<string, string>) => TablePreviewStyle;
export interface TablePresentation {
  markdown: string;
  labels: ReadonlyMap<string, string>;
  diagnostics: TablePreviewDiagnostic[];
  render(md: MarkdownIt, transformedMarkdown: string, resolveStyle: TablePreviewStyleResolver): string;
}

interface Attributes { id?: string; classes: string[]; values: Record<string, string> }
interface Caption { text: string; attributes: Attributes; start: number; end: number; prefix: string; level: number }
interface TableRecord { marker: string; captionStart: string; captionEnd: string; attributes: Attributes; caption: string; data?: TableData; number?: number; inlineMarker?: boolean }
interface Edit { start: number; end: number; replacement: string }
const parser = new MarkdownIt({ html: true });
const presets = new Set(["booktabs", "grid", "plain", "zebra", "compact"]);
const safeId = (value: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value);
const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const emptyAttributes = (): Attributes => ({ classes: [], values: Object.create(null) });

function applyEdits(source: string, edits: Edit[]): string {
  return edits.sort((a, b) => b.start - a.start || b.end - a.end).reduce((text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end), source);
}

function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") offsets.push(index + 1);
  offsets.push(source.length);
  return offsets;
}

/** Attribute values are metadata. Only the normalized style and safe ID reach HTML. */
function parseAttributes(text: string): Attributes | undefined {
  const result = emptyAttributes();
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] || "") && index < text.length) index++;
    if (index === text.length) break;
    const shorthand = text.slice(index).match(/^([#.])([A-Za-z0-9_][A-Za-z0-9_.:-]*)/);
    if (shorthand) {
      if (shorthand[1] === "#") { if (result.id) return undefined; result.id = shorthand[2]; }
      else result.classes.push(shorthand[2]);
      index += shorthand[0].length;
    } else {
      const key = text.slice(index).match(/^([A-Za-z][A-Za-z0-9_.:-]*)\s*=\s*/);
      if (!key) return undefined;
      index += key[0].length;
      let value = "";
      const quote = text[index];
      if (quote === '"' || quote === "'") {
        index++;
        let closed = false;
        while (index < text.length) {
          const character = text[index++];
          if (character === quote) { closed = true; break; }
          if (character === "\\" && (text[index] === quote || text[index] === "\\")) value += text[index++];
          else value += character;
        }
        if (!closed) return undefined;
      } else {
        const match = text.slice(index).match(/^[^\s{}"']+/);
        if (!match) return undefined;
        value = match[0]; index += value.length;
      }
      result.values[key[1]] = value;
    }
    if (index < text.length && !/\s/.test(text[index])) return undefined;
  }
  return result;
}

function captionFromParagraph(token: Token, inline: Token | undefined, source: string, offsets: number[]): Caption | undefined {
  if (token.type !== "paragraph_open" || !token.map || inline?.type !== "inline") return undefined;
  const start = offsets[token.map[0]], end = offsets[token.map[1]];
  const raw = inline.content.trim();
  const match = raw.match(/^(?::|Table:)[ \t]+([\s\S]*)$/);
  if (!match) return undefined;
  let text = match[1].trim(), attributes = emptyAttributes();
  if (text.endsWith("}")) {
    for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
      const precedingSlashes = text.slice(0, index).match(/\\+$/)?.[0].length || 0;
      const parsed = precedingSlashes % 2 ? undefined : parseAttributes(text.slice(index + 1, -1));
      if (parsed && (parsed.id || parsed.classes.length || Object.keys(parsed.values).length)) {
        attributes = parsed; text = text.slice(0, index).trim(); break;
      }
      if (index === 0) break;
    }
  }
  const firstLine = source.slice(start, end).split("\n")[0];
  const contentStart = firstLine.indexOf(inline.content.split("\n")[0]);
  const prefix = contentStart > 0 ? firstLine.slice(0, contentStart) : "";
  return { text, attributes, start, end, prefix, level: token.level };
}

function protectedCodeRanges(source: string, tokens: Token[], offsets: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = tokens.filter(token => token.map && (token.type === "fence" || token.type === "code_block" ||
    token.type === "html_block" && /^\s*<(?:pre|code|script|style)\b/i.test(token.content)))
    .map(token => [offsets[token.map![0]], offsets[token.map![1]]]);
  for (let index = 0; index < source.length; index++) {
    const block = ranges.find(([start, end]) => index >= start && index < end);
    if (block) { index = block[1] - 1; continue; }
    if (source[index] !== "`" || source[index - 1] === "\\") continue;
    let length = 1;
    while (source[index + length] === "`") length++;
    const expression = /`+/g; expression.lastIndex = index + length;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(source))) {
      if (match[0].length !== length) continue;
      ranges.push([index, match.index + length]); index = match.index + length - 1; break;
    }
    if (!match) index += length - 1;
  }
  return ranges;
}

function rawEnvironmentEnd(source: string, start: number): number | undefined {
  const stack: string[] = [];
  let braces = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "%") { const end = source.indexOf("\n", index); if (end < 0) return undefined; index = end; continue; }
    if (source[index] === "\\") {
      const command = source.slice(index).match(/^\\(begin|end)\{([A-Za-z*]+)\}/);
      if (command && braces === 0) {
        if (command[1] === "begin") stack.push(command[2]);
        else if (stack.pop() !== command[2]) return undefined;
        index += command[0].length - 1;
        if (!stack.length) return index + 1;
        continue;
      }
      const verb = source.slice(index).match(/^\\verb\*?([^A-Za-z\s])/);
      if (verb) {
        const end = source.indexOf(verb[1], index + verb[0].length);
        if (end < 0) return undefined;
        index = end; continue;
      }
      if (/[^A-Za-z]/.test(source[index + 1] || "")) { index++; continue; }
    }
    if (source[index] === "{") braces++;
    else if (source[index] === "}") { if (braces === 0) return undefined; braces--; }
  }
  return undefined;
}

function maskRawTables(source: string, marker: (kind: string) => string, diagnostics: TablePreviewDiagnostic[]): { markdown: string; replacements: Map<string, string> } {
  const tokens = parser.parse(source, {}), offsets = lineOffsets(source);
  const protectedRanges = protectedCodeRanges(source, tokens, offsets);
  const replacements = new Map<string, string>(), edits: Edit[] = [];
  const expression = /^ {0,3}\\begin\{(?:table\*?|tabular\*?|tabularx|longtable|longtblr|tblr)\}/gm;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source))) {
    if (protectedRanges.some(([start, end]) => match!.index >= start && match!.index < end)) continue;
    const end = rawEnvironmentEnd(source, match.index) ?? source.length;
    const raw = source.slice(match.index, end), key = marker("raw");
    diagnostics.push({ code: "raw-latex-table-preview", severity: "info", message: "Raw LaTeX tables are preserved for compilation. Their layout is available in the compiled PDF." });
    replacements.set(key, `<div class="inkwell-raw-table-notice" role="note"><p>Raw LaTeX table. View the compiled PDF for its layout.</p><details><summary>Show original LaTeX</summary><pre><code>${escapeHtml(raw)}</code></pre></details></div>\n`);
    edits.push({ start: match.index, end, replacement: `\n\n${key}\n\n` }); expression.lastIndex = end;
  }
  return { markdown: applyEdits(source, edits), replacements };
}

function presentationAttributes(attributes: Attributes): Record<string, string> {
  const values = { ...attributes.values };
  if (!Object.hasOwn(values, "table-preset") && !Object.hasOwn(values, "table-style")) {
    const preset = attributes.classes.find(value => presets.has(value));
    if (preset) values["table-preset"] = preset;
  }
  return values;
}

function columnAlignments(style: TablePreviewStyle, rows: Array<Array<string | undefined>>, count: number, sourceAlignment: Array<TableAlignment | undefined> = []): Array<TableAlignment | undefined> {
  return Array.from({ length: count }, (_, column) => {
    if (style.alignmentIsLocal && style.alignment?.[column]) return style.alignment[column];
    if (sourceAlignment[column]) return sourceAlignment[column];
    if (style.alignment?.[column]) return style.alignment[column];
    if (!style.numericAlignment || style.numericAlignment === "inherit") return undefined;
    const values = rows.map(row => row[column]);
    if (values.some(value => value === undefined || /[\r\n]/.test(value))) return undefined;
    const nonempty = (values as string[]).filter(value => value.trim() !== "");
    return nonempty.length && nonempty.every(isNumericTableValue) ? style.numericAlignment : undefined;
  });
}

function alignMarkdownCells(tokens: Token[], style: TablePreviewStyle): void {
  const cells: Array<{ token: Token; column: number }> = [], rows: Array<Array<string | undefined>> = [];
  const sourceAlignment: Array<TableAlignment | undefined> = [];
  let column = 0, width = 0, row: Array<string | undefined> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "tr_open") { column = 0; row = []; }
    if (token.type === "th_open" || token.type === "td_open") {
      cells.push({ token, column });
      if (token.type === "th_open") sourceAlignment[column] = token.attrGet("style")?.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)(?:\s*;|\s*$)/)?.[1] as TableAlignment | undefined;
      if (token.type === "td_open") {
        const inline = tokens[index + 1];
        row.push(inline?.type === "inline" && inline.children?.every(child => child.type === "text") ? inline.children.map(child => child.content).join("") : undefined);
      }
      column++; width = Math.max(width, column);
    }
    if (token.type === "tr_close" && row.length) rows.push(row);
  }
  const alignments = columnAlignments(style, rows, width, sourceAlignment);
  for (const cell of cells) {
    const alignment = alignments[cell.column];
    if (!alignment) continue;
    const existing = (cell.token.attrGet("style") || "").replace(/(?:^|;)\s*text-align\s*:[^;]*/gi, "");
    cell.token.attrSet("style", `${existing}${existing && !existing.endsWith(";") ? ";" : ""}text-align:${alignment}`);
  }
}

/** Extract before citation/reference transforms; render after them so captions retain their inline semantics. */
export function extractTablePresentation(markdown: string, options: { tablePrefix?: string } = {}): TablePresentation {
  const namespace = `INKWELLTABLE${crypto.createHash("sha256").update(markdown).digest("hex").slice(0, 32)}`;
  let nonce = namespace, collision = 0;
  while (markdown.includes(nonce)) nonce = `${namespace}X${++collision}`;
  let sequence = 0;
  const marker = (kind: string): string => `<!--${nonce}${kind}${sequence++}-->`;
  const diagnostics: TablePreviewDiagnostic[] = [], labels = new Map<string, string>();
  const masked = maskRawTables(markdown, marker, diagnostics);
  const source = masked.markdown, offsets = lineOffsets(source), tokens = parser.parse(source, {});
  const records = new Map<string, TableRecord>(), edits: Edit[] = [];
  const claimedCaptions = new Set<number>(), usedIds = new Set<string>();
  const prefix = options.tablePrefix || "Table";
  let tableNumber = 0;
  const paragraphCaptions = tokens.map((token, index) => captionFromParagraph(token, tokens[index + 1], source, offsets)).filter((value): value is Caption => Boolean(value));
  for (const token of tokens) {
    const isData = token.type === "fence" && token.info.trim() === TABLE_DATA_FENCE;
    if (!token.map || token.type !== "table_open" && !isData) continue;
    const start = offsets[token.map[0]], end = offsets[token.map[1]];
    let caption: Caption | undefined, data: TableData | undefined;
    if (isData) {
      try { data = decodeTableData(token.content); }
      catch (error) {
        const key = marker("dataerror");
        diagnostics.push({ code: "table-data-invalid", severity: "error", message: String(error) });
        masked.replacements.set(key, `<div class="inkwell-table-error" role="alert">Generated table could not be read: ${escapeHtml(String(error))}</div>\n`);
        edits.push({ start, end, replacement: `\n\n${key}\n\n` }); continue;
      }
    } else {
      const adjacent = (value: Caption, gap: string) => !claimedCaptions.has(value.start) && value.level === token.level && /^[\s>]*$/.test(gap);
      caption = paragraphCaptions.find(value => value.end <= start && adjacent(value, source.slice(value.end, start))) ||
        paragraphCaptions.find(value => value.start >= end && adjacent(value, source.slice(end, value.start)));
      if (caption) claimedCaptions.add(caption.start);
    }
    const attributes = data ? { id: data.label, classes: [], values: { ...data.attributes } } : caption?.attributes || emptyAttributes();
    if (attributes.id && (!safeId(attributes.id) || usedIds.has(attributes.id))) {
      diagnostics.push({ code: "table-id-invalid", severity: "warning", message: `Table ID ${attributes.id} is unsafe or duplicated and was omitted from the preview.` });
      attributes.id = undefined;
    }
    if (attributes.id) usedIds.add(attributes.id);
    const record: TableRecord = { marker: marker("table"), captionStart: marker("caption"), captionEnd: marker("endcaption"), attributes, caption: data?.caption || caption?.text || "", data, inlineMarker: !data && token.level > 0 };
    if (attributes.id?.startsWith("tbl:") && record.caption) {
      record.number = ++tableNumber; labels.set(attributes.id, `${prefix}\u00a0${tableNumber}`);
    }
    records.set(record.marker, record);
    const captionMarkdown = record.caption ? [record.captionStart, "", ...record.caption.split("\n"), "", record.captionEnd, ""].map(line => `${caption?.prefix || ""}${line}`).join("\n") + "\n" : "";
    if (data) edits.push({ start, end, replacement: `\n\n${record.marker}\n\n${captionMarkdown}` });
    else {
      if (record.inlineMarker) {
        const lineEnd = source.indexOf("\n", start), headerEnd = lineEnd < 0 ? source.length : lineEnd;
        const header = source.slice(start, headerEnd).trimEnd();
        const slashes = header.slice(0, -1).match(/\\+$/)?.[0].length || 0;
        const insertion = header.endsWith("|") && slashes % 2 === 0 ? start + header.length - 1 : headerEnd;
        edits.push({ start: insertion, end: insertion, replacement: ` ${record.marker} ` });
      } else edits.push({ start, end: start, replacement: `${record.marker}\n\n` });
      if (caption) edits.push({ start: caption.start, end: caption.end, replacement: captionMarkdown });
    }
  }
  return {
    markdown: applyEdits(source, edits), labels, diagnostics,
    render(md, transformedMarkdown, resolveStyle) {
      const environment = {}, renderedTokens = md.parse(transformedMarkdown, environment);
      const captions = new Map<string, string>(), consumed = new Set<number>();
      const inlineTables = new Map<number, TableRecord>();
      for (let index = 0; index < renderedTokens.length; index++) {
        if (renderedTokens[index].type !== "table_open") continue;
        for (let childIndex = index + 1; childIndex < renderedTokens.length && renderedTokens[childIndex].type !== "table_close"; childIndex++) {
          const token = renderedTokens[childIndex];
          if (token.type !== "inline") continue;
          token.children = (token.children || []).filter(child => {
            const record = child.type === "html_inline" ? records.get(child.content.trim()) : undefined;
            if (!record?.inlineMarker) return true;
            inlineTables.set(index, record); return false;
          });
        }
      }
      for (const record of records.values()) {
        const start = renderedTokens.findIndex(token => token.type === "html_block" && token.content.trim() === record.captionStart);
        const end = renderedTokens.findIndex((token, index) => index > start && token.type === "html_block" && token.content.trim() === record.captionEnd);
        if (start < 0 || end < 0) continue;
        const content = renderedTokens.slice(start + 1, end);
        const inline = content.length === 3 && content[0].type === "paragraph_open" && content[1].type === "inline" && content[2].type === "paragraph_close";
        captions.set(record.marker, inline ? md.renderer.renderInline(content[1].children || [], md.options, environment) : md.renderer.render(content, md.options, environment));
        for (let index = start; index <= end; index++) consumed.add(index);
      }
      const output: Token[] = [];
      for (let index = 0; index < renderedTokens.length; index++) {
        if (consumed.has(index)) continue;
        const token = renderedTokens[index], key = token.type === "html_block" ? token.content.trim() : "";
        const raw = masked.replacements.get(key);
        if (raw !== undefined) { token.content = raw; output.push(token); continue; }
        const record = inlineTables.get(index) || records.get(key);
        if (!record) { output.push(token); continue; }
        const style = resolveStyle(presentationAttributes(record.attributes));
        diagnostics.push(...style.diagnostics || []);
        const preset = presets.has(style.preset) ? style.preset : "plain";
        const captionHtml = captions.get(record.marker);
        const caption = captionHtml ? `<caption style="caption-side:${style.captionPosition === "below" ? "bottom" : "top"}">${record.number ? `<strong>${escapeHtml(prefix)}\u00a0${record.number}:</strong> ` : ""}${captionHtml}</caption>\n` : "";
        const tableAttributes = ` class="inkwell-table table-preset-${preset}"${record.attributes.id ? ` id="${escapeHtml(record.attributes.id)}"` : ""}`;
        const provenance = Object.entries(record.attributes.values).filter(([name]) => /^data-inkwell-[a-z0-9-]+$/.test(name)).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join("");
        let table: string;
        if (record.data) {
          const cell = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");
          const alignments = columnAlignments(style, record.data.rows, record.data.headers.length);
          const aligned = (column: number) => alignments[column] ? ` style="text-align:${alignments[column]}"` : "";
          table = `<table${tableAttributes}${provenance}>\n${caption}<thead><tr>${record.data.headers.map((value, column) => `<th class="inkwell-table-literal"${aligned(column)}>${cell(value)}</th>`).join("")}</tr></thead>\n<tbody>${record.data.rows.map(row => `<tr>${row.map((value, column) => `<td class="inkwell-table-literal"${aligned(column)}>${cell(value)}</td>`).join("")}</tr>`).join("\n")}</tbody>\n</table>\n`;
        } else {
          const tableStart = record.inlineMarker ? index : index + 1;
          if (renderedTokens[tableStart]?.type !== "table_open") continue;
          let tableEnd = tableStart + 1;
          while (tableEnd < renderedTokens.length && renderedTokens[tableEnd].type !== "table_close") tableEnd++;
          if (tableEnd === renderedTokens.length) continue;
          const opening = renderedTokens[tableStart];
          alignMarkdownCells(renderedTokens.slice(tableStart, tableEnd + 1), style);
          opening.attrJoin("class", `inkwell-table table-preset-${preset}`);
          if (record.attributes.id) opening.attrSet("id", record.attributes.id);
          for (const [name, value] of Object.entries(record.attributes.values)) if (/^data-inkwell-[a-z0-9-]+$/.test(name)) opening.attrSet(name, value);
          table = md.renderer.render([opening], md.options, environment) + caption + md.renderer.render(renderedTokens.slice(tableStart + 1, tableEnd + 1), md.options, environment);
          index = tableEnd;
        }
        const replacement: Token = Object.assign(Object.create(Object.getPrototypeOf(token)), token, { type: "html_block", tag: "", nesting: 0,
          content: `<div class="inkwell-table-scroll" role="region" aria-label="${escapeHtml(prefix)}" tabindex="0" style="${escapeHtml(style.cssText)}">\n${table}</div>\n` });
        output.push(replacement);
      }
      return md.renderer.render(output, md.options, environment);
    },
  };
}
