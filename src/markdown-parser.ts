import type MarkdownIt from "markdown-it";

/** Load the Markdown engine only when a document actually needs parsing. */
export function createMarkdownParser(options?: MarkdownIt.Options): MarkdownIt {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Markdown = require("markdown-it") as typeof MarkdownIt;
  return new Markdown(options || {});
}
