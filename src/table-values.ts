import { normalizeHeadingWeight, normalizeTypographyColor } from "./style-model";

export const TABLE_PRESETS = ["booktabs", "grid", "plain", "zebra", "compact"] as const;
export type TablePreset = typeof TABLE_PRESETS[number];
export type TableAlignment = "left" | "center" | "right";
export interface TableAttributeRule {
  field: string; configKey: string; aliases: string[];
  type: "enum" | "boolean" | "color" | "size" | "weight" | "alignment" | "width";
  values?: readonly string[]; minimum?: number; maximum?: number;
}
/** Serialized with the PDF options so table attributes have one public contract. */
export const TABLE_ATTRIBUTE_SCHEMA: readonly TableAttributeRule[] = [
  { field: "preset", configKey: "tables.preset", aliases: ["table-preset", "table-style", "tables"], type: "enum", values: TABLE_PRESETS },
  { field: "stripe", configKey: "tables.stripe", aliases: ["table-stripe"], type: "boolean" },
  { field: "density", configKey: "tables.density", aliases: ["table-density"], type: "enum", values: ["normal", "compact", "comfortable"] },
  { field: "fontSizePt", configKey: "typography.tableSize", aliases: ["table-font-size"], type: "size", minimum: 0.1, maximum: 200 },
  { field: "headerWeight", configKey: "tables.headerWeight", aliases: ["table-header-weight"], type: "weight" },
  { field: "headerBackground", configKey: "tables.headerBackground", aliases: ["table-header-background", "table-header-bg"], type: "color" },
  { field: "stripeColor", configKey: "tables.stripeColor", aliases: ["table-stripe-color"], type: "color" },
  { field: "ruleColor", configKey: "tables.ruleColor", aliases: ["table-rule-color"], type: "color" },
  { field: "ruleThicknessPt", configKey: "tables.ruleThickness", aliases: ["table-rule-thickness"], type: "size", minimum: 0, maximum: 10 },
  { field: "paddingHorizontalPt", configKey: "tables.paddingHorizontal", aliases: ["table-padding-horizontal", "table-cell-padding-horizontal"], type: "size", minimum: 0, maximum: 40 },
  { field: "paddingVerticalPt", configKey: "tables.paddingVertical", aliases: ["table-padding-vertical", "table-cell-padding-vertical"], type: "size", minimum: 0, maximum: 40 },
  { field: "alignment", configKey: "tables.alignment", aliases: ["table-alignment", "table-column-alignment"], type: "alignment" },
  { field: "numericAlignment", configKey: "tables.numericAlignment", aliases: ["table-numeric-alignment"], type: "enum", values: ["inherit", "left", "center", "right"] },
  { field: "width", configKey: "tables.width", aliases: ["table-width"], type: "width" },
  { field: "overflow", configKey: "tables.overflow", aliases: ["table-overflow"], type: "enum", values: ["wrap", "fit"] },
  { field: "captionPosition", configKey: "tables.captionPosition", aliases: ["table-caption-position", "caption-style"], type: "enum", values: ["above", "below"] },
  { field: "captionStyle", configKey: "tables.captionStyle", aliases: ["table-caption-style"], type: "enum", values: ["normal", "italic"] },
];

export function parseTableColor(value: unknown): string | undefined {
  return value === "none" || value === "transparent" ? "transparent" : normalizeTypographyColor(value);
}
export function parseTableAlignment(value: unknown): TableAlignment[] | undefined {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.trim().split(/[ ,]+/) : [];
  const aliases: Record<string, TableAlignment> = { l: "left", c: "center", r: "right", left: "left", center: "center", right: "right" };
  return parts.length && parts.length <= 100 && parts.every(item => typeof item === "string" && Object.hasOwn(aliases, item))
    ? parts.map(item => aliases[String(item)]) : undefined;
}
export function parseTableWidth(value: unknown): string | undefined {
  if (value === "auto") return value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(%|pt|px|in|cm|mm)?$/);
  if (!match || Number(match[1]) <= 0) return undefined;
  const amount = Number(match[1]), unit = match[2] || "%";
  if (unit === "%") return amount <= 100 ? `${amount}%` : undefined;
  const points = amount * (unit === "px" ? 0.75 : unit === "in" ? 72.27 : unit === "cm" ? 72.27 / 2.54 : unit === "mm" ? 72.27 / 25.4 : 1);
  return points <= 1000 ? `${Math.round(points * 1e6) / 1e6}pt` : undefined;
}
export const parseTableWeight = normalizeHeadingWeight;

/** Literal numeric cells; never execute or coerce arbitrary artifact text. */
export function isNumericTableValue(value: string): boolean {
  return /^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(value.trim());
}
