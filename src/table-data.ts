import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

export const TABLE_DATA_FENCE = "inkwell-table-data";
export const TABLE_DATA_ERROR_FENCE = "inkwell-table-error";
export const TABLE_DATA_LIMITS = Object.freeze({ sourceBytes: 5 * 1024 * 1024, payloadBytes: 12 * 1024 * 1024,
  rows: 10000, columns: 256, cells: 50000, recordCharacters: 1024 * 1024 });
export interface TableData {
  schemaVersion: 1;
  headers: string[];
  rows: string[][];
  caption?: string;
  label?: string;
  attributes: Record<string, string>;
}
export interface TableDataMetadata { caption?: string; label?: string; attributes?: Record<string, string> }
export interface TableDataDiagnostic { severity: "error"; code: string; message: string; source: string; line?: number; column?: number }
export class TableDataError extends Error {
  constructor(public readonly code: string, message: string, public readonly line?: number, public readonly column?: number, options?: ErrorOptions) {
    super(message, options); this.name = "TableDataError";
  }
}
const mapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const newline = (text: string): string => text.replace(/\r\n?/g, "\n");
function boundedSource(text: string): void {
  if (Buffer.byteLength(text, "utf8") > TABLE_DATA_LIMITS.sourceBytes) throw new TableDataError("table-source-limit", "Table artifact exceeds the 5 MiB input limit. Export a smaller table or split it into separate artifacts.");
}
function checkedText(value: unknown): string {
  if (typeof value !== "string") throw new TableDataError("table-cell-type", "Table headers and cells must be literal strings.");
  if (value.includes("\0")) throw new TableDataError("table-cell-text", "Table text contains a NUL character, which cannot be represented safely in preview and PDF.");
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(++index);
      if (next >= 0xDC00 && next <= 0xDFFF) continue;
      throw new TableDataError("table-cell-text", "Table text contains an unpaired Unicode surrogate. Export valid Unicode text.");
    }
    if (code >= 0xDC00 && code <= 0xDFFF) throw new TableDataError("table-cell-text", "Table text contains an unpaired Unicode surrogate. Export valid Unicode text.");
  }
  return newline(value);
}

function validateTable(value: unknown): TableData {
  if (!mapping(value) || value.schemaVersion !== 1 || !Array.isArray(value.headers) || !Array.isArray(value.rows) || !mapping(value.attributes)) {
    throw new TableDataError("table-payload-schema", "Expected a version 1 table payload with headers, rows, and string attributes.");
  }
  if (!value.headers.length) throw new TableDataError("table-empty-header", "A table needs at least one column.");
  if (value.headers.length > TABLE_DATA_LIMITS.columns || value.rows.length > TABLE_DATA_LIMITS.rows || (value.rows.length + 1) * value.headers.length > TABLE_DATA_LIMITS.cells) {
    throw new TableDataError("table-dimensions-limit", "Table exceeds the limit of 256 columns, 10,000 rows, or 50,000 cells. Export a smaller table.");
  }
  const headers = value.headers.map(checkedText);
  const rows = value.rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== headers.length) throw new TableDataError("table-column-count", `Table row ${index + 1} must contain ${headers.length} cells.`);
    return row.map(checkedText);
  });
  if ([headers, ...rows].some(row => row.reduce((size, cell) => size + cell.length, 0) > TABLE_DATA_LIMITS.recordCharacters)) {
    throw new TableDataError("table-record-limit", "A table record exceeds the 1 MiB character limit. Shorten the record before rendering it.");
  }
  const attributes = Object.fromEntries(Object.entries(value.attributes).map(([key, item]) => [key, checkedText(item)]));
  const caption = value.caption === undefined ? undefined : checkedText(value.caption);
  const label = value.label === undefined ? undefined : checkedText(value.label);
  if (label !== undefined && !/^tbl:[A-Za-z0-9_.:-]+$/.test(label)) throw new TableDataError("table-label", "Table labels must start with tbl: and use letters, numbers, underscores, periods, colons, or hyphens.");
  return { schemaVersion: 1, headers, rows, ...(caption === undefined ? {} : { caption }), ...(label === undefined ? {} : { label }), attributes };
}

export function parseCsvTable(text: string, metadata: TableDataMetadata = {}): TableData {
  boundedSource(text);
  let records: string[][];
  try {
    records = parse(text, { bom: true, columns: false, cast: false, trim: false, skip_empty_lines: false,
      relax_quotes: false, relax_column_count: false, max_record_size: TABLE_DATA_LIMITS.recordCharacters,
      // Stop as soon as excess dimensions are known, before accumulating a huge record array.
      on_record: (record: string[], context) => {
        if (record.length > TABLE_DATA_LIMITS.columns || context.records > TABLE_DATA_LIMITS.rows + 1 || context.records * record.length > TABLE_DATA_LIMITS.cells) {
          throw new TableDataError("table-dimensions-limit", "CSV table exceeds the limit of 256 columns, 10,000 rows, or 50,000 cells. Export a smaller table.", context.lines);
        }
        return record;
      } });
  } catch (error: any) {
    if (error instanceof TableDataError) throw error;
    throw new TableDataError(`csv-${String(error.code || "parse").toLowerCase()}`, `CSV could not be parsed: ${String(error.message || error).slice(0, 1000)}`,
      typeof error.lines === "number" ? error.lines : undefined, typeof error.column === "number" ? error.column + 1 : undefined, { cause: error });
  }
  if (!records.length) throw new TableDataError("table-empty-csv", "CSV artifact has no header record.");
  return validateTable({ schemaVersion: 1, headers: records[0], rows: records.slice(1), ...metadata, attributes: metadata.attributes || {} });
}

function jsonCell(value: unknown, present: boolean): string {
  if (!present) return "";
  checkJsonNumbers(value);
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); }
  catch (error) { throw new TableDataError("table-json-cell", "A nested JSON cell could not be represented as literal text.", undefined, undefined, { cause: error }); }
}

function checkJsonNumbers(value: unknown): void {
  const remaining: unknown[] = [value];
  while (remaining.length) {
    const item = remaining.pop();
    if (typeof item === "number" && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) {
      throw new TableDataError("table-json-number", "A JSON number exceeds the exact numeric range. Export very large numbers as strings to preserve their digits.");
    }
    if (Array.isArray(item)) for (const nested of item) remaining.push(nested);
    else if (mapping(item)) for (const nested of Object.values(item)) remaining.push(nested);
  }
}

/** Non-tabular JSON remains ordinary JSON output, including empty arrays. */
export function parseJsonTable(text: string, metadata: TableDataMetadata = {}): TableData | undefined {
  boundedSource(text);
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { throw new TableDataError("table-json-parse", `JSON could not be parsed: ${String(error).slice(0, 1000)}`, undefined, undefined, { cause: error }); }
  if (!Array.isArray(data) || !data.length || !data.some(mapping)) return undefined;
  if (!data.every(mapping)) throw new TableDataError("table-json-rows", "A JSON table must contain only object records. Mixed scalar, array, or null rows cannot be guessed into columns.");
  if (data.length > TABLE_DATA_LIMITS.rows) throw new TableDataError("table-dimensions-limit", "JSON table exceeds the 10,000-row limit. Export a smaller table.");
  const headers = [...new Set(data.flatMap(row => Object.keys(row)))];
  if (!headers.length) return undefined;
  if (headers.length > TABLE_DATA_LIMITS.columns || (data.length + 1) * headers.length > TABLE_DATA_LIMITS.cells) {
    throw new TableDataError("table-dimensions-limit", "JSON table exceeds the 256-column or 50,000-cell limit. Export a smaller table.");
  }
  const rows = data.map(row => headers.map(key => jsonCell(row[key], Object.hasOwn(row, key))));
  return validateTable({ schemaVersion: 1, headers, rows, ...metadata, attributes: metadata.attributes || {} });
}

export function decodeTableData(text: string): TableData {
  if (Buffer.byteLength(text, "utf8") > TABLE_DATA_LIMITS.payloadBytes) throw new TableDataError("table-payload-limit", "Generated table payload exceeds the 12 MiB transport limit.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new TableDataError("table-payload-json", "Generated table payload is not valid JSON.", undefined, undefined, { cause: error }); }
  return validateTable(value);
}

export function literalFence(text: string, language = "text"): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function encodeTableData(table: TableData): string {
  const text = JSON.stringify(validateTable(table));
  decodeTableData(text);
  return literalFence(text, TABLE_DATA_FENCE);
}

export function artifactTableLabel(document: string, block: string, artifact: string, explicit?: string, multiple = false): string {
  const hash = createHash("sha256").update(JSON.stringify([document, block, artifact])).digest("hex").slice(0, 16);
  if (explicit) {
    const label = explicit.startsWith("tbl:") ? explicit : `tbl:${explicit}`;
    return multiple ? `${label}-${hash}` : label;
  }
  return `tbl:inkwell-${hash}`;
}

export function tableDataDiagnostic(error: unknown, source: string): TableDataDiagnostic {
  if (error instanceof TableDataError) return { severity: "error", code: error.code, message: error.message, source,
    ...(error.line === undefined ? {} : { line: error.line }), ...(error.column === undefined ? {} : { column: error.column }) };
  return { severity: "error", code: "table-artifact-read", message: `Table artifact could not be read: ${String(error).slice(0, 1000)}`, source };
}
