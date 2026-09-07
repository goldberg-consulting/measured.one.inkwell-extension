import type { DocumentConfig, LatexSize, SizeValue } from "./document-config";

/** TeX points (1/72.27in) differ slightly from CSS/PDF points (1/72in). */
export const TEX_POINT_TO_CSS_POINT = 72 / 72.27;
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const latexSizes: Record<number, Record<LatexSize, number>> = {
  9: { tiny: 5, scriptsize: 6, footnotesize: 7, small: 8, normalsize: 9, large: 10, Large: 10.95, LARGE: 12, huge: 14.4, Huge: 17.28 },
  10: { tiny: 5, scriptsize: 7, footnotesize: 8, small: 9, normalsize: 10, large: 12, Large: 14.4, LARGE: 17.28, huge: 20.74, Huge: 24.88 },
  11: { tiny: 6, scriptsize: 8, footnotesize: 9, small: 10, normalsize: 10.95, large: 12, Large: 14.4, LARGE: 17.28, huge: 20.74, Huge: 24.88 },
  12: { tiny: 6, scriptsize: 8, footnotesize: 10, small: 10.95, normalsize: 12, large: 14.4, Large: 17.28, LARGE: 20.74, huge: 24.88, Huge: 24.88 },
};

export function namedSizeInPoints(name: LatexSize, classSize = 11): number {
  const table = latexSizes[classSize];
  return table ? table[name] : round(latexSizes[10][name] * classSize / 10);
}

/** Relative sizes are relative to the document body, never editor chrome. */
export function sizeInPoints(size: SizeValue, bodySize = 11, classSize = bodySize): number {
  if (size.unit === "latex") return namedSizeInPoints(size.value, classSize);
  const multiplier = size.unit === "px" ? 0.75 : size.unit === "em" || size.unit === "rem" ? bodySize : size.unit === "%" ? bodySize / 100 : 1;
  return round(size.value * multiplier);
}

export function normalizeFontFamily(value: unknown): string | undefined {
  // A family name, not a TeX command, CSS declaration or list of font options.
  return typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]*$/u.test(value.trim()) ? value.trim() : undefined;
}
export function normalizeHeadingWeight(value: unknown): "normal" | "bold" | undefined {
  return value === "normal" || value === 400 || value === "400" ? "normal" : value === "bold" || value === 700 || value === "700" ? "bold" : undefined;
}
const colors: Record<string, string> = {
  black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", navy: "000080", gray: "808080", grey: "808080",
  silver: "c0c0c0", maroon: "800000", purple: "800080", teal: "008080", olive: "808000", yellow: "ffff00", orange: "ffa500",
  fuchsia: "ff00ff", magenta: "ff00ff", aqua: "00ffff", cyan: "00ffff", lime: "00ff00", royalblue: "4169e1", darkblue: "00008b",
};
export function normalizeTypographyColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase();
  if (Object.hasOwn(colors, raw)) return `#${colors[raw]}`;
  if (/^#[a-f0-9]{6}$/.test(raw)) return raw;
  if (/^#[a-f0-9]{3}$/.test(raw)) return `#${[...raw.slice(1)].map(c => c + c).join("")}`;
  const rgb = raw.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  return rgb && rgb.slice(1).every(channel => Number(channel) <= 255) ? `#${rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}` : undefined;
}

export interface EffectiveTypography {
  classSizePt: number; bodySizePt: number; codeSizePt: number; captionSizePt: number; tableSizePt: number; referenceSizePt: number;
  headingSizesPt: number[]; lineSpacing: number; lineHeight: number; bodyBaselinePt: number;
  bodyFont: string; sansFont: string; monoFont: string; headingFont: string; headingWeight: "normal" | "bold"; headingColor: string;
  approximation?: string;
}
export function hasTypographyOverride(config: DocumentConfig, field: string): boolean {
  const source = config.provenance[`typography.${field}`]?.source;
  return Boolean(source && source !== "builtin" && source !== "template" && !config.deferredBindings.some(binding => binding.key === `typography.${field}`));
}
export function resolveTypography(config: DocumentConfig): EffectiveTypography {
  const typography = config.typography;
  const fallback = config.template === "eth-report" ? 12 : 11;
  const classSizePt = typography.bodySize ? sizeInPoints(typography.bodySize, fallback, fallback) : fallback;
  const bodySizePt = namedSizeInPoints("normalsize", classSizePt);
  const size = (field: "codeSize" | "captionSize" | "tableSize" | "referenceSize", defaultSize: number): number =>
    typography[field] ? sizeInPoints(typography[field]!, bodySizePt, classSizePt) : defaultSize;
  const fixedFonts: Record<string, string> = { rho: "STIX Two Text", rmxaa: "STIX Two Text", tufte: "Palatino", "tufte-book-vdqi": "Palatino", "kth-letter": "Times", ludus: "Source Sans 3" };
  const bodyFont = typography.bodyFont || (config.template === "eth-report" ? "Inter" : fixedFonts[config.template] || "Latin Modern Roman");
  const sansFont = typography.sansFont || (config.template === "eth-report" ? "Inter" : "Latin Modern Sans");
  // Default's historical Highlighting environment inherits body size. Other
  // wrappers explicitly select small (or footnotesize in Hipster CV).
  const codeSizePt = hasTypographyOverride(config, "codeSize") || config.template !== "default"
    ? size("codeSize", bodySizePt) : bodySizePt;
  const headingOverride = ["headingFont", "headingWeight", "headingScale", "headingColor"].some(field => hasTypographyOverride(config, field));
  const normalBaseline = ({ 9: 10.95, 10: 12, 11: 13.6, 12: 14.5 } as Record<number, number>)[classSizePt] || bodySizePt * 1.2;
  // ETH invokes onehalfspacing while its class is still 12pt, before applying
  // document fontsize. setspace chooses 1.241 for that 12pt class.
  const lineSpacing = config.template === "eth-report" && !hasTypographyOverride(config, "lineSpacing") ? 1.241 : typography.lineSpacing || 1;
  const bodyBaselinePt = round(normalBaseline * lineSpacing);
  return {
    classSizePt, bodySizePt, codeSizePt, captionSizePt: size("captionSize", bodySizePt), tableSizePt: size("tableSize", bodySizePt), referenceSizePt: size("referenceSize", bodySizePt),
    headingSizesPt: ["Large", "large", "normalsize", "normalsize", "normalsize", "normalsize"].map(name => round((config.template === "eth-report" && !headingOverride ? bodySizePt : namedSizeInPoints(name as LatexSize, classSizePt)) * (typography.headingScale || 1))),
    lineSpacing, bodyBaselinePt, lineHeight: round(bodyBaselinePt / bodySizePt), bodyFont, sansFont, monoFont: typography.monoFont || "Latin Modern Mono",
    headingFont: typography.headingFont || (config.template === "eth-report" ? sansFont : bodyFont),
    headingWeight: normalizeHeadingWeight(typography.headingWeight) || "bold", headingColor: normalizeTypographyColor(typography.headingColor) || "#000000",
    approximation: config.capabilities.typographyNotice || (config.template !== "default" && config.template !== "eth-report" ? "Draft approximates class-owned fonts and layout; the compiled PDF is authoritative." : undefined),
  };
}

/** Declarations only: the caller scopes these to its rendered article. */
export function buildTypographyCss(config: DocumentConfig): string {
  const effective = resolveTypography(config);
  const declarations: string[] = [];
  const size = (name: string, value: number) => declarations.push(`--inkwell-${name}-size:${round(value * TEX_POINT_TO_CSS_POINT)}pt`);
  for (const [name, value] of Object.entries({ body: effective.bodySizePt, code: effective.codeSizePt, table: effective.tableSizePt, caption: effective.captionSizePt, reference: effective.referenceSizePt })) size(name, value);
  effective.headingSizesPt.forEach((value, index) => size(`heading-${index + 1}`, value));
  for (const [name, value] of Object.entries({ body: effective.bodyFont, sans: effective.sansFont, mono: effective.monoFont, heading: effective.headingFont })) {
    const fallback = name === "mono" ? "monospace" : name === "sans" || config.template === "eth-report" ? "sans-serif" : "serif";
    declarations.push(`--inkwell-${name}-font:${JSON.stringify(value)},${fallback}`);
  }
  declarations.push(`--inkwell-heading-weight:${effective.headingWeight === "bold" ? 700 : 400}`, `--inkwell-heading-color:${hasTypographyOverride(config, "headingColor") ? effective.headingColor : "inherit"}`, `--inkwell-line-spacing:${effective.lineHeight}`);
  return declarations.join(";") + ";";
}

const fontCommand = (points: number): string => `\\fontsize{${points}pt}{${round(points * 1.2)}pt}\\selectfont`;
export function buildTypographyPreamble(config: DocumentConfig): string {
  const effective = resolveTypography(config);
  const explicit = (field: string) => hasTypographyOverride(config, field);
  const lines: string[] = [];
  for (const [field, command, optionsKey] of [["bodyFont", "setmainfont", "mainfontoptions"], ["sansFont", "setsansfont", "sansfontoptions"], ["monoFont", "setmonofont", "monofontoptions"]] as const) {
    if (!explicit(field)) continue;
    const options = config.compatibility[optionsKey];
    const retained = Array.isArray(options) ? options.map(String) : typeof options === "string" ? [options] : [];
    // The old global MatchLowercase scaled nominal point sizes differently for
    // every chosen family. Explicit family choices now retain physical points.
    // A user's explicit Scale option remains authoritative.
    const hasScale = retained.some(option => /(?:^|,)\s*Scale\s*=/i.test(option));
    const fontOptions = [...retained, ...(hasScale ? [] : ["Scale=1"])].join(",");
    lines.push(`\\${command}[${fontOptions}]{${config.typography[field]}}`);
  }
  if (["headingFont", "headingWeight", "headingScale", "headingColor"].some(explicit)) {
    lines.push("% Inkwell heading typography");
    const family = explicit("headingFont") ? "\\inkwellheadingfont" : config.template === "eth-report" ? "\\sffamily" : "\\rmfamily";
    if (explicit("headingFont")) lines.push(`\\newfontfamily\\inkwellheadingfont{${effective.headingFont}}[Scale=1]`);
    lines.push(`\\definecolor{inkwellheadingcolor}{HTML}{${effective.headingColor.slice(1)}}`);
    const format = (index: number) => `\\normalfont${family}${fontCommand(effective.headingSizesPt[index])}${effective.headingWeight === "bold" ? "\\bfseries" : "\\mdseries"}\\color{inkwellheadingcolor}`;
    if (config.template === "eth-report") {
      ["section", "subsection", "subsubsection", "paragraph", "subparagraph"].forEach((heading, index) => lines.push(`\\setkomafont{${heading}}{${format(index)}}`));
      // The class's singlespacing resets the current size. Keep its numbering,
      // indentation and hanging layout, then restore the declared heading font.
      lines.push("\\makeatletter", "\\renewcommand*\\sectionlinesformat[4]{\\noindent\\singlespacing\\usekomafont{#1}\\@hangfrom{\\hskip #2#3}{#4}}", "\\makeatother");
    } else {
      ["section", "subsection", "subsubsection"].forEach((heading, index) => lines.push(`\\titleformat{\\${heading}}{${format(index)}}{\\the${heading}}{1em}{}`));
      ["paragraph", "subparagraph"].forEach((heading, index) => lines.push(`\\titleformat{\\${heading}}[runin]{${format(index + 3)}}{\\the${heading}}{1em}{}`));
    }
  }
  if (explicit("codeSize")) {
    lines.push("% Inkwell highlighted and plain code sizing", "\\usepackage{fvextra}", `\\newcommand{\\inkwellcodesize}{${fontCommand(effective.codeSizePt)}}`,
      "\\DefineVerbatimEnvironment{Highlighting}{Verbatim}{commandchars=\\\\\\{\\},breaklines,breakanywhere,fontsize=\\inkwellcodesize}",
      "\\DefineVerbatimEnvironment{verbatim}{Verbatim}{breaklines,breakanywhere,fontsize=\\inkwellcodesize}");
  }
  if (explicit("captionSize")) lines.push("% Inkwell figure and body-table caption sizing", `\\DeclareCaptionFont{inkwellcaption}{${fontCommand(effective.captionSizePt)}}`, "\\captionsetup[figure]{font=inkwellcaption}", "\\captionsetup[table]{font=inkwellcaption}");
  if (explicit("tableSize")) lines.push("% Used only by body-typography.lua around Pandoc Table nodes", `\\newcommand{\\inkwellbodytablesize}{${fontCommand(effective.tableSizePt)}}`);
  if (explicit("referenceSize")) lines.push("% Inkwell citeproc bibliography sizing", "\\usepackage{etoolbox}", `\\AtBeginEnvironment{CSLReferences}{${fontCommand(effective.referenceSizePt)}}`);
  return lines.join("\n");
}
