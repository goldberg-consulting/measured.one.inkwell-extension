// Compatibility accessors backed by the shared YAML parser. New consumers use
// DocumentConfig directly; these preserve the existing internal helper API.
import { parseDocumentFrontmatter } from "./document-config";

export interface SplitFrontmatter { fm: string; body: string }

export function splitFrontmatter(text: string): SplitFrontmatter | undefined {
  const parsed = parseDocumentFrontmatter(text);
  return parsed.hasFrontmatter ? { fm: parsed.rawYaml.replace(/\r\n/g, "\n"), body: parsed.body } : undefined;
}

export function extractIndentedBlock(fm: string, key: string): string | undefined {
  const parsed = parseDocumentFrontmatter(`---\n${fm}\n---\n`);
  const value = parsed.metadata[key];
  return value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : undefined;
}

export function extractIndentedValue(block: string, key: string): string | undefined {
  const value = parseDocumentFrontmatter(`---\n${block}\n---\n`).metadata[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}
