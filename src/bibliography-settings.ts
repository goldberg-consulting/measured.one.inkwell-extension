import { stringify } from "yaml";
import { DocumentConfig, resolveDocumentConfig, sizeToString, SizeValue } from "./document-config";
import { planFrontmatterSettingsEdit } from "./document-style";

export interface BibliographySetting { key: string; label: string; kind: "bibliography" | "csl" | "choice" | "text"; choices?: readonly (string | boolean)[]; prompt: string }
export const BIBLIOGRAPHY_SETTINGS: readonly BibliographySetting[] = [
  { key: "references.bibliography", label: "Bibliography files", kind: "bibliography", prompt: "Create or choose BibTeX files" },
  { key: "references.csl", label: "Citation style", kind: "csl", prompt: "Choose an existing CSL style" },
  { key: "references.scope", label: "Bibliography scope", kind: "choice", choices: ["document", "section"], prompt: "One bibliography for the document or one per top-level section" },
  { key: "references.heading", label: "References heading", kind: "text", prompt: "Heading shown above the reference list" },
  { key: "references.links", label: "Citation links", kind: "choice", choices: [true, false], prompt: "Link citations to their bibliography entries" },
  { key: "typography.referenceSize", label: "Reference font size", kind: "text", prompt: "Reference font size, for example 10pt or small" },
  { key: "references.hangingIndent", label: "Hanging indent", kind: "text", prompt: "Indent wrapped lines, for example 2em; use 0pt for no indent" },
  { key: "references.lineSpacing", label: "Reference line spacing", kind: "text", prompt: "Line-spacing multiplier, for example 1 or 1.2" },
  { key: "references.entrySpacing", label: "Space between entries", kind: "text", prompt: "Space between entries, for example 0.4em or 6pt" },
  { key: "references.pageBreak", label: "Reference page break", kind: "choice", choices: ["auto", "always", "never"], prompt: "Automatic layout, always start a new page, or never force a page break" },
];
export function bibliographySettingValue(config: DocumentConfig, key: string): unknown {
  if (key === "typography.referenceSize") return config.typography.referenceSize ? sizeToString(config.typography.referenceSize) : "Template-defined";
  return config.references[key.slice("references.".length) as keyof DocumentConfig["references"]];
}
export function validateBibliographySetting(config: DocumentConfig, key: string, value: unknown): { key: string; value: unknown } {
  if (!BIBLIOGRAPHY_SETTINGS.some(setting => setting.key === key)) throw new Error("Unknown bibliography setting.");
  const capability = config.capabilities.options[key];
  if (capability && capability.support !== "supported") throw new Error(capability.reason || "This setting is controlled by the selected template.");
  const [section, field] = key.split(".");
  const checked = resolveDocumentConfig({ text: `---\n${stringify({ [section]: { [field]: value } })}---\n`,
    manifest: { template: config.template }, templateCapabilities: config.capabilities });
  const diagnostic = checked.diagnostics.find(item => item.key === key && (item.severity === "error" || item.code === "template-capability"));
  if (diagnostic) throw new Error(diagnostic.message);
  if (checked.deferredBindings.some(item => item.key === key)) throw new Error("Enter a concrete bibliography setting.");
  const normalized = key === "typography.referenceSize" ? checked.typography.referenceSize : bibliographySettingValue(checked, key);
  if (normalized === undefined) throw new Error("Enter a supported bibliography value.");
  return { key, value: typeof normalized === "object" && normalized !== null && "unit" in normalized ? sizeToString(normalized as SizeValue) : normalized };
}
export function planBibliographyEdit(text: string, key: string, value: unknown, config: DocumentConfig) {
  return planFrontmatterSettingsEdit(text, [validateBibliographySetting(config, key, value)], config.sourcePath);
}
