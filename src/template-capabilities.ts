import { TABLE_ATTRIBUTE_SCHEMA } from "./table-values";

/** Capabilities describe the adapters shipped today, rather than planned UI. */
export interface TemplateOptionCapability {
  support: "supported" | "locked" | "unsupported";
  /** Effective template-owned value. Omitted when the class determines it. */
  value?: unknown;
  allowed?: readonly (string | number | boolean)[];
  reason?: string;
  /** Human-readable class value when it cannot be expressed as a portable font name. */
  valueLabel?: string;
}

export interface TemplateCapabilities {
  id: string;
  name: string;
  engine: "xelatex" | "pdflatex" | "lualatex";
  columns: 1 | 2;
  options: Readonly<Record<string, TemplateOptionCapability>>;
  defaults: Readonly<Record<string, unknown>>;
  /** Unknown user templates require their own explicit adapter metadata. */
  custom?: boolean;
  /** Draft approximation when author-provided class/font options own layout. */
  typographyNotice?: string;
}

const supported = (allowed?: TemplateOptionCapability["allowed"]): TemplateOptionCapability => ({ support: "supported", ...(allowed ? { allowed } : {}) });
const locked = (value: unknown, reason: string): TemplateOptionCapability => ({ support: "locked", value, reason });
const pending = (reason: string): TemplateOptionCapability => ({ support: "unsupported", reason });
const fontSizes = ["tiny", "scriptsize", "footnotesize", "small", "normalsize"];
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

const sharedOptions: Readonly<Record<string, TemplateOptionCapability>> = {
  "typography.headingFont": pending("Heading font overrides do not yet have a matching PDF adapter."),
  "typography.headingWeight": pending("Heading weight is defined by the template until its PDF adapter supports this option."),
  "typography.headingScale": pending("Heading scale overrides do not yet have a matching PDF adapter."),
  "typography.headingColor": pending("Heading color overrides do not yet have a matching PDF adapter."),
  "typography.codeSize": supported(fontSizes),
  "typography.captionSize": pending("Caption font sizing does not yet have a matching PDF adapter."),
  "typography.tableSize": pending("Table font sizing requires the scoped body-table adapter."),
  "typography.referenceSize": pending("Reference font sizing does not yet have a matching PDF adapter."),
  "tables.preset": supported(["booktabs"]),
  "tables.stripe": pending("Table stripes require the scoped body-table adapter."),
  "tables.density": pending("Table density requires the scoped body-table adapter."),
  "tables.captionPosition": pending("Caption placement requires the scoped body-table adapter."),
};

const typographyAdapterOptions: Readonly<Record<string, TemplateOptionCapability>> = {
  "typography.headingFont": supported(),
  "typography.headingWeight": supported(["normal", "bold"]),
  "typography.headingScale": supported(),
  "typography.headingColor": supported(),
  "typography.codeSize": supported(),
  "typography.captionSize": supported(),
  "typography.tableSize": supported(),
  "typography.referenceSize": supported(),
};
const tableAdapterOptions: Readonly<Record<string, TemplateOptionCapability>> = Object.fromEntries(TABLE_ATTRIBUTE_SCHEMA
  .filter(rule => rule.configKey.startsWith("tables."))
  .map(rule => [rule.configKey, supported(rule.field === "overflow" ? ["wrap"] : rule.values)]));
const lockedFamilies: Record<string, string> = {
  "hipster-cv": "Latin Modern Roman (class-owned)", "kth-letter": "Times (class-owned)",
  ludus: "Source Sans 3; Helvetica Neue or Latin Modern Sans fallback", rho: "STIX Two Text (class-owned)",
  rmxaa: "STIX Two Text (class-owned)", tmsce: "Latin Modern Roman (class-owned)",
  tufte: "Palatino (class-owned)", "tufte-book-vdqi": "Palatino (class-owned)",
};

function capabilities(
  id: string, name: string, engine: TemplateCapabilities["engine"], columns: 1 | 2,
  bodySize: string, bodyFonts: boolean, lineSpacing: number | undefined,
): TemplateCapabilities {
  const reason = `${name} owns this option. Choose the Default template to customize it.`;
  const options = {
    ...sharedOptions,
    ...Object.fromEntries(TABLE_ATTRIBUTE_SCHEMA.filter(rule => rule.configKey.startsWith("tables.")).map(rule => [rule.configKey,
      id === "default" || id === "eth-report" ? tableAdapterOptions[rule.configKey]
        : ["rho", "rmxaa", "ludus", "hipster-cv"].includes(id) && ["width", "overflow"].includes(rule.field)
          ? supported(rule.field === "overflow" ? ["wrap"] : undefined)
        : rule.field === "preset" ? locked("booktabs", `${name} preserves its native body-table rules. Choose Default or ETH Report for other presets.`)
        : locked(rule.field === "captionPosition" ? "above" : undefined, `${name} owns this table option. Choose Default or ETH Report for configurable body-table styles.`)])),
    ...(id === "default" || id === "eth-report" ? typographyAdapterOptions : {}),
    "typography.bodyFont": bodyFonts ? supported() : { ...locked(undefined, reason), valueLabel: lockedFamilies[id] || "Class-owned font" },
    "typography.sansFont": bodyFonts ? supported() : { ...locked(undefined, reason), valueLabel: "Class-owned sans-serif font" },
    "typography.monoFont": bodyFonts ? supported() : { ...locked(undefined, reason), valueLabel: "Class-owned monospace font" },
    "typography.bodySize": bodyFonts ? supported(["10pt", "11pt", "12pt"]) : locked(bodySize, reason),
    "typography.lineSpacing": bodyFonts ? supported() : locked(lineSpacing, reason),
    "columns": locked(columns, reason),
    "engine": locked(engine, `${name} requires ${engine}. Select a compatible template to change the engine.`),
  };
  return immutable({
    id, name, engine, columns, options: Object.freeze(options),
    defaults: Object.freeze({
      typography: { bodySize, ...(lineSpacing === undefined ? {} : { lineSpacing }), codeSize: id === "hipster-cv" ? "footnotesize" : "small" },
      tables: { preset: "booktabs", stripe: false, density: "normal", captionPosition: "above" },
      columns, engine,
    }),
  });
}

/** Every shipped template has an explicit entry; custom classes opt in separately. */
export const TEMPLATE_CAPABILITIES: Readonly<Record<string, TemplateCapabilities>> = Object.freeze({
  default: capabilities("default", "Default", "xelatex", 1, "11pt", true, 1.4),
  "eth-report": capabilities("eth-report", "ETH Report", "xelatex", 1, "12pt", true, 1.5),
  "hipster-cv": capabilities("hipster-cv", "Hipster CV", "pdflatex", 2, "10pt", false, undefined),
  "kth-letter": capabilities("kth-letter", "KTH Letter", "pdflatex", 1, "11pt", false, undefined),
  ludus: capabilities("ludus", "Ludus Academik", "xelatex", 2, "10pt", false, undefined),
  rho: capabilities("rho", "Rho Academic Article", "pdflatex", 2, "9pt", false, undefined),
  rmxaa: capabilities("rmxaa", "RMxAA", "pdflatex", 2, "9pt", false, undefined),
  tmsce: capabilities("tmsce", "TMSCE", "pdflatex", 1, "11pt", false, undefined),
  tufte: capabilities("tufte", "Tufte Handout", "pdflatex", 1, "10pt", false, undefined),
  "tufte-book-vdqi": capabilities("tufte-book-vdqi", "Tufte Book VDQI", "pdflatex", 1, "10pt", false, undefined),
});

export function getTemplateCapabilities(templateId: string): TemplateCapabilities {
  const id = templateId === "inkwell" ? "default" : templateId;
  const known = Object.hasOwn(TEMPLATE_CAPABILITIES, id) ? TEMPLATE_CAPABILITIES[id] : undefined;
  if (known) return known;
  const baseline = capabilities(id, id, "xelatex", 1, "11pt", false, undefined);
  return immutable({
    ...baseline, custom: true,
    options: Object.freeze(Object.fromEntries(Object.keys(baseline.options).map((key) => [key,
      pending(`Custom template ${id} has no declared support for ${key}. Add capability metadata to its template.json.`),
    ]))),
  });
}

/** Author class choices can supersede the bundled wrapper's size/hierarchy. */
export function constrainTypographyCapabilities(base: TemplateCapabilities, context: {
  documentClass?: string; topLevelDivision?: string; classOptions?: unknown; requestedBodySize?: number;
}): TemplateCapabilities {
  const options = { ...base.options };
  const defaults = structuredClone(base.defaults) as Record<string, any>;
  const rawOptions = Array.isArray(context.classOptions) ? context.classOptions.map(String) : typeof context.classOptions === "string" ? context.classOptions.split(",") : [];
  const sizes = rawOptions.map(option => option.trim()).filter(option => /^(?:9|10|11|12)pt$/.test(option)).map(parseFloat);
  let classSize = sizes.length ? `${Math.max(...sizes)}pt` : undefined;
  if (base.id === "default" && sizes.length) {
    // Standard classes process declared options in ascending size order. The
    // wrapper always emits fontsize (11pt when absent) before classoption.
    classSize = `${Math.max(context.requestedBodySize || 11, ...sizes)}pt`;
  } else if (["rho", "rmxaa"].includes(base.id) && rawOptions.length && !sizes.length) {
    // Supplying classoption suppresses the wrapper's entire 9pt default list;
    // extarticle then chooses its own 10pt default.
    classSize = "10pt";
  }
  if (classSize && ["default", "kth-letter", "rho", "rmxaa"].includes(base.id)) {
    defaults.typography = { ...defaults.typography, bodySize: classSize };
    options["typography.bodySize"] = { support: "locked", value: classSize, valueLabel: `${classSize} from classoption`,
      reason: "classoption selects the effective class size. Remove its size option to use the document font-size control." };
  }
  const customClass = base.id === "default" && context.documentClass && context.documentClass !== "article";
  const customHierarchy = context.topLevelDivision && context.topLevelDivision !== "section";
  let typographyNotice = base.typographyNotice;
  if ((base.id === "default" || base.id === "eth-report") && (customClass || customHierarchy)) {
    const reason = "The heading adapter supports article sections. Use documentclass: article with top-level-division: section, or keep the class-owned heading design.";
    for (const field of ["headingFont", "headingWeight", "headingScale", "headingColor"]) options[`typography.${field}`] = { support: "unsupported", reason, valueLabel: "Class-owned headings" };
    typographyNotice = "Custom document class or heading hierarchy: Draft approximates the class-owned heading layout. The compiled PDF is authoritative.";
  }
  return immutable({ ...base, options, defaults, ...(typographyNotice ? { typographyNotice } : {}) });
}
