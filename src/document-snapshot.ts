import type * as vscode from "vscode";

/** A separate snapshot object works with the editor's frozen TextDocument API.
 * Consumers use captured text/version; identity and editor methods remain on the
 * original prototype. Never proxy read-only, non-configurable API properties.
 */
export function createDocumentSnapshot(document: vscode.TextDocument, text = document.getText(), version = document.version): vscode.TextDocument {
  const lines = text.split(/\r?\n/);
  const offsets = [0];
  for (const match of text.matchAll(/\r?\n/g)) offsets.push(match.index! + match[0].length);
  const offsetAt = (position: vscode.Position) => {
    if (position.line < 0) return 0;
    if (position.line >= offsets.length) return text.length;
    return offsets[position.line] + Math.max(0, Math.min(position.character, lines[position.line].length));
  };
  return Object.create(document, {
    getText: { value: (range?: vscode.Range) => range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text },
    version: { value: version },
    lineCount: { value: lines.length },
    offsetAt: { value: offsetAt },
  }) as vscode.TextDocument;
}
