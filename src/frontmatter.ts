// Shared YAML frontmatter primitives. Several modules previously each
// re-implemented "find the --- ... --- block and pull a value out of the
// inkwell: sub-mapping" with subtly different regexes. The variants
// anchored on a literal "\n" silently failed on CRLF documents, so on
// Windows the preview styling, code-block display mode, python-env, and
// LaTeX preamble all no-opped. These helpers handle CRLF once, in one
// place, by normalizing the captured frontmatter to LF (the body is left
// byte-for-byte untouched).

export interface SplitFrontmatter {
  /** The YAML between the leading and trailing `---`, normalized to LF. */
  fm: string;
  /** Everything after the closing `---`, unmodified. */
  body: string;
}

export function splitFrontmatter(text: string): SplitFrontmatter | undefined {
  const match = text.match(
    /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/,
  );
  if (!match) return undefined;
  return { fm: match[1].replace(/\r\n/g, "\n"), body: match[2] };
}

/** A top-level scalar value, e.g. `title: "..."`. Operates on LF frontmatter. */
export function extractScalar(fm: string, key: string): string | undefined {
  const m = fm.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  return m ? m[1].trim() : undefined;
}

/**
 * The indented block beneath a `key:` line with nothing after the colon
 * (e.g. the `inkwell:` mapping). Returns the raw indented lines joined by
 * LF, or undefined when the key is absent.
 */
export function extractIndentedBlock(fm: string, key: string): string | undefined {
  const m = fm.match(new RegExp(`^${key}:\\s*$`, "m"));
  if (!m) return undefined;
  const start = m.index! + m[0].length;
  const lines = fm.substring(start).split("\n");
  const block: string[] = [];
  for (const line of lines) {
    if (/^\S/.test(line) && line.trim()) break;
    block.push(line);
  }
  return block.join("\n");
}

/** An indented scalar inside a block returned by {@link extractIndentedBlock}. */
export function extractIndentedValue(block: string, key: string): string | undefined {
  const m = block.match(
    new RegExp(`^\\s+${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m"),
  );
  return m ? m[1].trim() : undefined;
}
