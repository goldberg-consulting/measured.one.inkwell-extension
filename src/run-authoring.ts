import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CodeBlock, parseCodeBlocks } from "./runner";
import { BLOCK_ID_PATTERN, blockIdentityErrors } from "./run-attributes";
import { containedRunPath } from "./run-paths";

export interface RunTextEdit { start: number; end: number; replacement: string }
export interface ExtractionPlan {
  sourcePath: string; source: string; blockId: string; edit: RunTextEdit;
}

function blockOffsets(markdown: string, block: CodeBlock): { start: number; end: number } {
  let start = 0;
  for (let line = 1; line < block.startLine; line++) start = markdown.indexOf("\n", start) + 1;
  if (markdown.slice(start, start + block.raw.length) !== block.raw) throw new Error("The document changed; select the block again.");
  return { start, end: start + block.raw.length };
}

/** Assign each anonymous fence an identity in the document, never in a sidecar. */
export function planBlockIdentities(markdown: string, createId = () => `run-${crypto.randomUUID().slice(0, 12)}`): RunTextEdit[] {
  const blocks = parseCodeBlocks(markdown);
  const errors = blockIdentityErrors(blocks);
  if (errors.size) throw new Error([...errors].map(([line, messages]) => `Line ${line}: ${messages.join(" ")}`).join("\n"));
  const used = new Set(blocks.map(block => block.id || block.label).filter(Boolean));
  return blocks.filter(block => !block.id && !block.label).map(block => {
    let id = createId(); let tries = 0;
    while (used.has(id) && tries++ < 100) id = createId();
    if (!BLOCK_ID_PATTERN.test(id) || used.has(id)) throw new Error("Could not generate a unique, valid block ID.");
    used.add(id);
    const offsets = blockOffsets(markdown, block);
    const headerEnd = markdown.indexOf("\n", offsets.start);
    const close = markdown.lastIndexOf("}", headerEnd);
    return { start: close, end: close, replacement: ` id="${id}"` };
  });
}

export function applyRunTextEdits(markdown: string, edits: RunTextEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.replacement + markdown.slice(edit.end);
  return markdown;
}

export function scriptExtension(language: string): string {
  const extensions: Record<string, string> = { python: ".py", python3: ".py", r: ".R", node: ".js", javascript: ".js", shell: ".sh", bash: ".sh", sh: ".sh" };
  const extension = extensions[language.toLowerCase()];
  if (!extension) throw new Error(`Cannot extract unsupported language: ${language}`);
  return extension;
}

export function planScriptExtraction(markdown: string, blockIndex: number, projectRoot: string, slug?: string): ExtractionPlan {
  const blocks = parseCodeBlocks(markdown);
  const block = blocks.find(candidate => candidate.index === blockIndex);
  if (!block) throw new Error("Select an executable code block first.");
  if (block.file) throw new Error("This block already uses an external script.");
  const errors = blockIdentityErrors(blocks);
  if (errors.size) throw new Error([...errors.values()].flat().join("\n"));
  const blockId = block.id || block.label || slug || `run-${crypto.randomUUID().slice(0, 12)}`;
  const name = slug || blockId;
  if (!BLOCK_ID_PATTERN.test(name) || !BLOCK_ID_PATTERN.test(blockId)) throw new Error("Use a letter followed by up to 63 letters, digits, underscores, or hyphens.");
  if (blocks.some(other => other !== block && (other.id || other.label) === blockId)) throw new Error(`Duplicate block ID: ${blockId}`);
  const relativePath = `.inkwell/scripts/${name}${scriptExtension(block.lang)}`;
  const sourcePath = containedRunPath(projectRoot, path.join(projectRoot, relativePath), true, true);
  if (fs.existsSync(sourcePath)) throw new Error(`The script already exists: ${relativePath}. Choose a different name.`);
  const offsets = blockOffsets(markdown, block);
  const firstNewline = block.raw.indexOf("\n");
  const lastNewline = block.raw.lastIndexOf("\n");
  const header = block.raw.slice(0, firstNewline).replace(/\r$/, "");
  const newline = block.raw[firstNewline - 1] === "\r" ? "\r\n" : "\n";
  const closing = block.raw.slice(lastNewline + 1);
  const replacement = header.replace(/}\s*$/, `${block.id || block.label ? "" : ` id="${blockId}"`} file="${relativePath}"}`) + newline + closing;
  return { sourcePath, source: block.raw.slice(firstNewline + 1, lastNewline + 1), blockId, edit: { ...offsets, replacement } };
}

/** The adapter commits a text edit only after exclusive source creation succeeds. */
export async function extractScriptTransaction(plan: ExtractionPlan, projectRoot: string, commitDocument: (edit: RunTextEdit) => Promise<boolean>): Promise<void> {
  containedRunPath(projectRoot, plan.sourcePath, true, true);
  fs.mkdirSync(path.dirname(plan.sourcePath), { recursive: true });
  containedRunPath(projectRoot, plan.sourcePath, true, true);
  fs.writeFileSync(plan.sourcePath, plan.source, { flag: "wx" });
  let committed = false;
  try {
    committed = await commitDocument(plan.edit);
    if (!committed) throw new Error("The document changed or could not be edited. Extraction was cancelled.");
  } finally {
    if (!committed) {
      containedRunPath(projectRoot, plan.sourcePath, false, true);
      // An independently edited script becomes user-owned, even during rollback.
      if (fs.readFileSync(plan.sourcePath, "utf8") === plan.source) fs.unlinkSync(plan.sourcePath);
    }
  }
}
