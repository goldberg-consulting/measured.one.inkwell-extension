export const BLOCK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Commas separate entries; an escaped comma belongs to the filename. */
export function parseRunList(value: string): string[] {
  const items: string[] = [];
  let item = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\" && value[index + 1] === ",") { item += ","; index++; }
    else if (value[index] === ",") { if (item.trim()) items.push(item.trim()); item = ""; }
    else item += value[index];
  }
  if (item.trim()) items.push(item.trim());
  return items;
}

/** Strict, non-evaluating attribute parser; malformed syntax is never silently ignored. */
export function parseQuotedAttrs(value: string): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < value.length) {
    while (/\s/.test(value[offset] || "") && offset < value.length) offset++;
    if (offset === value.length) break;
    const key = /^[A-Za-z][\w-]*/.exec(value.slice(offset))?.[0];
    if (!key) throw new Error("Expected a code block attribute name.");
    offset += key.length;
    while (/\s/.test(value[offset] || "") && offset < value.length) offset++;
    if (value[offset++] !== "=") throw new Error(`Expected '=' after ${key}.`);
    while (/\s/.test(value[offset] || "") && offset < value.length) offset++;
    const quote = ["'", '"'].includes(value[offset]) ? value[offset++] : undefined;
    let result = ""; let closed = !quote;
    while (offset < value.length) {
      const character = value[offset++];
      if (quote && character === quote) { closed = true; break; }
      if (!quote && /\s/.test(character)) break;
      if (character === "\\" && (value[offset] === quote || value[offset] === "\\")) result += value[offset++];
      else result += character;
    }
    if (!closed) throw new Error(`Unclosed quote in ${key}.`);
    if (quote && offset < value.length && !/\s/.test(value[offset])) throw new Error(`Expected whitespace after ${key}.`);
    if (Object.prototype.hasOwnProperty.call(attributes, key)) throw new Error(`Duplicate code block attribute: ${key}`);
    attributes[key] = result;
  }
  return attributes;
}

export interface IdentityBlock { id?: string; label?: string; startLine: number }
export function blockIdentityErrors(blocks: IdentityBlock[]): Map<number, string[]> {
  const errors = new Map<number, string[]>();
  const names = new Map<string, number[]>();
  const add = (line: number, message: string) => errors.set(line, [...errors.get(line) || [], message]);
  for (const block of blocks) {
    // A display label such as fig:plot remains valid when a separate stable ID exists.
    const id = block.id ?? block.label;
    if (!id) continue;
    if (!BLOCK_ID_PATTERN.test(id)) add(block.startLine, `Invalid block ID "${id}". Use a letter followed by up to 63 letters, digits, underscores, or hyphens; add id= when the display label uses other characters.`);
    names.set(id, [...names.get(id) || [], block.startLine]);
  }
  for (const [name, lines] of names) if (lines.length > 1) for (const line of lines) add(line, `Duplicate block ID or label: ${name}`);
  return errors;
}
