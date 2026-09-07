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

function capabilities(
  id: string, name: string, engine: TemplateCapabilities["engine"], columns: 1 | 2,
  bodySize: string, bodyFonts: boolean, lineSpacing: number | undefined,
): TemplateCapabilities {
  const reason = `${name} owns this option. Choose the Default template to customize it.`;
  const options = {
    ...sharedOptions,
    "typography.bodyFont": bodyFonts ? supported() : locked(undefined, reason),
    "typography.sansFont": bodyFonts ? supported() : locked(undefined, reason),
    "typography.monoFont": bodyFonts ? supported() : locked(undefined, reason),
    "typography.bodySize": bodyFonts ? supported(id === "default" ? ["10pt", "11pt", "12pt"] : undefined) : locked(bodySize, reason),
    "typography.lineSpacing": bodyFonts ? supported() : locked(lineSpacing, reason),
    "columns": locked(columns, reason),
    "engine": locked(engine, `${name} requires ${engine}. Select a compatible template to change the engine.`),
  };
  return immutable({
    id, name, engine, columns, options: Object.freeze(options),
    defaults: Object.freeze({
      typography: { bodySize, ...(lineSpacing === undefined ? {} : { lineSpacing }), codeSize: id === "hipster-cv" ? "footnotesize" : "small" },
      tables: { preset: "booktabs", stripe: false, density: "normal", captionPosition: "below" },
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
