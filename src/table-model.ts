import { applyBlockOverrides, ConfigDiagnostic, DocumentConfig, SizeValue } from "./document-config";
import { namedSizeInPoints, resolveTypography, sizeInPoints, TEX_POINT_TO_CSS_POINT, TYPOGRAPHY_COLORS } from "./style-model";
import { TABLE_ATTRIBUTE_SCHEMA, TableAlignment, TablePreset } from "./table-values";

export interface TableStyle {
  preset: TablePreset; stripe: boolean; density: "normal" | "compact" | "comfortable";
  fontSizePt: number; headerWeight: "normal" | "bold"; headerBackground: string; stripeColor: string;
  ruleColor: string; ruleThicknessPt: number; paddingHorizontalPt: number; paddingVerticalPt: number;
  alignment: TableAlignment[]; numericAlignment: "inherit" | TableAlignment;
  width: string; overflow: "wrap" | "fit"; captionPosition: "above" | "below"; captionStyle: "normal" | "italic";
}
export const TABLE_PRESET_DEFAULTS: Readonly<Record<TablePreset, Partial<TableStyle>>> = {
  booktabs: { stripe: false, density: "normal", ruleThicknessPt: 0.8, headerBackground: "transparent" },
  grid: { stripe: false, density: "normal", ruleThicknessPt: 0.5, headerBackground: "transparent" },
  plain: { stripe: false, density: "normal", ruleThicknessPt: 0, headerBackground: "transparent" },
  zebra: { stripe: true, density: "normal", ruleThicknessPt: 0.8, headerBackground: "transparent" },
  compact: { stripe: false, density: "compact", ruleThicknessPt: 0.5, headerBackground: "transparent" },
};
const densityPadding = { normal: [6, 3], compact: [3, 1.5], comfortable: [8, 5] } as const;
const explicit = (config: DocumentConfig, key: string): boolean => {
  const source = config.provenance[key]?.source;
  return Boolean(source && source !== "builtin" && source !== "template");
};
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Document/project values have already passed the shared resolver; attributes
 * are applied through that same resolver with the strongest, table-local scope. */
export function resolveTableStyle(config: DocumentConfig, attributes: Record<string, unknown> = {}): { style: TableStyle; diagnostics: readonly ConfigDiagnostic[] } {
  const effective = Object.keys(attributes).length ? applyBlockOverrides(config, attributes) : config;
  const typography = resolveTypography(effective);
  const table = effective.tables, preset = TABLE_PRESET_DEFAULTS[table.preset];
  const density = explicit(effective, "tables.density") ? table.density : preset.density || "normal";
  const padding = densityPadding[density];
  const diagnostics = [...effective.diagnostics];
  const points = (value: SizeValue | undefined, fallback: number, key: string): number => {
    if (!value) return fallback;
    const result = sizeInPoints(value, typography.bodySizePt, typography.classSizePt);
    const rule = TABLE_ATTRIBUTE_SCHEMA.find(item => item.configKey === key)!;
    if (result >= (rule.minimum || 0) && result <= (rule.maximum || Infinity)) return result;
    diagnostics.push({ sourcePath: effective.sourcePath, line: effective.provenance[key]?.line || 1, column: effective.provenance[key]?.column || 1,
      severity: "error", code: "table-size-range", key, message: `${key} must resolve to ${rule.minimum || 0}–${rule.maximum} TeX points.` });
    return fallback;
  };
  const style: TableStyle = {
    preset: table.preset, stripe: explicit(effective, "tables.stripe") ? table.stripe : preset.stripe || false, density,
    fontSizePt: points(table.fontSize, typography.tableSizePt, "typography.tableSize"),
    headerWeight: table.headerWeight || "bold", headerBackground: table.headerBackground || preset.headerBackground || "transparent",
    stripeColor: table.stripeColor || "#f5f5fa", ruleColor: table.ruleColor || "#000000",
    ruleThicknessPt: points(table.ruleThickness, preset.ruleThicknessPt || 0, "tables.ruleThickness"),
    paddingHorizontalPt: points(table.paddingHorizontal, padding[0], "tables.paddingHorizontal"),
    paddingVerticalPt: points(table.paddingVertical, padding[1], "tables.paddingVertical"),
    alignment: table.alignment || [], numericAlignment: table.numericAlignment || "inherit",
    width: table.width || "auto", overflow: table.overflow || "wrap",
    captionPosition: table.captionPosition, captionStyle: table.captionStyle || "normal",
  };
  return { style: Object.freeze(style), diagnostics: Object.freeze(diagnostics) };
}

/** CSS declarations only; callers scope these to a body table's scroll wrapper. */
export function buildTableCss(style: TableStyle): string {
  const declarations: string[] = [];
  const size = (key: string, points: number) => declarations.push(`--inkwell-table-${key}:${round(points * TEX_POINT_TO_CSS_POINT)}pt`);
  size("font-size", style.fontSizePt); size("rule-thickness", style.ruleThicknessPt);
  size("padding-horizontal", style.paddingHorizontalPt); size("padding-vertical", style.paddingVerticalPt);
  declarations.push(`--inkwell-table-header-weight:${style.headerWeight === "bold" ? 700 : 400}`,
    `--inkwell-table-header-background:${style.headerBackground}`, `--inkwell-table-stripe-color:${style.stripe ? style.stripeColor : "transparent"}`,
    `--inkwell-table-rule-color:${style.ruleColor === "#000000" ? "currentColor" : style.ruleColor}`,
    `--inkwell-table-caption-style:${style.captionStyle}`,
    `--inkwell-table-width:${style.width === "auto" ? "100%" : style.width.endsWith("pt") ? `${round(parseFloat(style.width) * TEX_POINT_TO_CSS_POINT)}pt` : style.width}`);
  return declarations.join(";") + ";";
}

export function tablePdfOptions(config: DocumentConfig) {
  const { style, diagnostics } = resolveTableStyle(config);
  const typography = resolveTypography(config);
  const explicitFields = TABLE_ATTRIBUTE_SCHEMA.filter(rule => explicit(config, rule.configKey)).map(rule => rule.field);
  const supported = Object.fromEntries(TABLE_ATTRIBUTE_SCHEMA.map(rule => [rule.field, config.capabilities.options[rule.configKey]?.support === "supported"]));
  return {
    schemaVersion: 1, enabled: explicitFields.length > 0, templateId: config.template,
    defaults: style, explicit: explicitFields, supported,
    allowed: Object.fromEntries(TABLE_ATTRIBUTE_SCHEMA.filter(rule => config.capabilities.options[rule.configKey]?.allowed).map(rule => [rule.field, config.capabilities.options[rule.configKey].allowed])),
    presets: TABLE_PRESET_DEFAULTS, densityPadding,
    bodySizePt: typography.bodySizePt, classSizePt: typography.classSizePt,
    namedSizes: Object.fromEntries(["tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge"].map(name => [name, namedSizeInPoints(name as Parameters<typeof namedSizeInPoints>[0], typography.classSizePt)])),
    attributeSchema: TABLE_ATTRIBUTE_SCHEMA,
    // The shared configuration parser normalizes document colors. These aliases
    // are serialized for the Lua table-attribute boundary as well.
    colors: { ...Object.fromEntries(Object.entries(TYPOGRAPHY_COLORS).map(([key, value]) => [key, `#${value}`])), none: "transparent", transparent: "transparent" },
    diagnostics,
  };
}
