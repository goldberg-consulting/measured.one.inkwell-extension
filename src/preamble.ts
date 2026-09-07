// Dynamic LaTeX preamble generator. Reads inkwell style options from
// YAML frontmatter (code-bg, tables, hanging-indent, etc.) and emits
// the corresponding LaTeX packages and environment redefinitions.
//
// The generated preamble is merged into the *template copy* in the
// compile cache (injectPreambleIntoTemplate), not passed via -H:
// pandoc treats -H files as the `header-includes` template variable,
// which silently REPLACES the document's own `header-includes`
// metadata. A document could then compile cleanly while losing its
// font, spacing, table, and citation commands. Injecting into the
// template keeps the document's header-includes as the only writer of
// that variable, and places them after the generated block so document
// commands override Inkwell styles. writePreambleFile remains as the
// -H fallback for templates without a recognizable injection point.

import * as fs from "fs";
import * as path from "path";
import { DocumentConfig, resolveDocumentConfig } from "./document-config";

export interface InkwellStyle {
  "code-bg"?: string;
  "code-border"?: boolean;
  "code-font-size"?: string;
  "code-rounded"?: boolean;
  tables?: "booktabs" | "grid" | "plain";
  "table-font-size"?: string;
  "table-stripe"?: boolean;
  "hanging-indent"?: boolean;
  columns?: number;
  "caption-style"?: "above" | "below";
}

export function parseInkwellStyle(text: string, resolved?: DocumentConfig): InkwellStyle {
  const metadata = (resolved || resolveDocumentConfig({ text })).compatibility;
  const raw = metadata.inkwell;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const values = raw as Record<string, unknown>;
  const style: InkwellStyle = {};
  for (const key of ["code-bg", "code-font-size", "table-font-size"] as const) {
    if (typeof values[key] === "string") style[key] = values[key];
  }
  for (const key of ["code-border", "code-rounded", "table-stripe", "hanging-indent"] as const) {
    if (typeof values[key] === "boolean") style[key] = values[key];
  }
  const table = values.tables && typeof values.tables === "object" ? (values.tables as Record<string, unknown>).preset : values.tables;
  if (table === "booktabs" || table === "grid" || table === "plain") style.tables = table;
  if (typeof values.columns === "number") style.columns = values.columns;
  if (values["caption-style"] === "above" || values["caption-style"] === "below") style["caption-style"] = values["caption-style"];
  return style;
}

function parseHexColor(hex: string): { r: number; g: number; b: number } | undefined {
  const clean = hex.replace(/^#/, "");
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.substring(0, 2), 16),
      g: parseInt(clean.substring(2, 4), 16),
      b: parseInt(clean.substring(4, 6), 16),
    };
  }
  return undefined;
}

const VALID_LATEX_FONT_SIZES = ["tiny", "scriptsize", "footnotesize", "small", "normalsize"];

const NAMED_COLORS: Record<string, string> = {
  "light-gray": "245,245,245",
  "light-grey": "245,245,245",
  "warm-gray": "248,244,240",
  "cool-gray": "240,243,248",
  "light-blue": "237,244,252",
  "light-yellow": "255,252,237",
  "none": "",
};

export function generatePreamble(style: InkwellStyle): string {
  const lines: string[] = [];

  if (style["code-bg"] || style["code-border"] || style["code-font-size"] || style["code-rounded"]) {
    lines.push("% Inkwell code block styling");

    let bgRgb = "248,248,248";
    if (style["code-bg"]) {
      const named = NAMED_COLORS[style["code-bg"]];
      if (named !== undefined) {
        bgRgb = named;
      } else {
        const parsed = parseHexColor(style["code-bg"]);
        if (parsed) bgRgb = `${parsed.r},${parsed.g},${parsed.b}`;
      }
    }

    if (bgRgb) {
      lines.push(`\\definecolor{inkwell-shade}{RGB}{${bgRgb}}`);
      lines.push(`\\definecolor{shadecolor}{RGB}{${bgRgb}}`);
    }

    if (style["code-border"]) {
      lines.push("\\usepackage{mdframed}");
      lines.push("\\renewenvironment{Shaded}{%");
      lines.push("  \\begin{mdframed}[backgroundcolor=inkwell-shade," +
        "linewidth=0.4pt," +
        "linecolor=black!20," +
        "innerleftmargin=8pt,innerrightmargin=8pt," +
        "innertopmargin=6pt,innerbottommargin=6pt," +
        "skipabove=6pt,skipbelow=6pt]}{\\end{mdframed}}");
    }

    if (style["code-font-size"]) {
      const size = style["code-font-size"];
      if (VALID_LATEX_FONT_SIZES.includes(size)) {
        lines.push("\\usepackage{fvextra}");
        // breaklines/breakanywhere must be restated: this redefinition
        // replaces the template's own Highlighting environment, and
        // dropping them silently re-enables overfull code lines.
        lines.push(`\\DefineVerbatimEnvironment{Highlighting}{Verbatim}{commandchars=\\\\\\{\\},breaklines,breakanywhere,fontsize=\\${size}}`);
      }
    }
  }

  if (style.tables === "booktabs" || style["table-font-size"] || style["table-stripe"]) {
    lines.push("");
    lines.push("% Inkwell table styling");

    if (style["table-stripe"]) {
      lines.push("\\usepackage{colortbl}");
      lines.push("\\definecolor{inkwell-stripe}{RGB}{245,245,250}");
      lines.push("\\rowcolors{2}{white}{inkwell-stripe}");
    }

    if (style["table-font-size"]) {
      const size = style["table-font-size"];
      if (VALID_LATEX_FONT_SIZES.includes(size)) {
        lines.push(`\\AtBeginEnvironment{longtable}{\\${size}}`);
        lines.push(`\\AtBeginEnvironment{tabular}{\\${size}}`);
        lines.push("\\usepackage{etoolbox}");
      }
    }
  }

  if (style["hanging-indent"]) {
    lines.push("");
    lines.push("% Inkwell hanging indent for lists");
    lines.push("\\usepackage{enumitem}");
    lines.push("\\setlist[enumerate]{leftmargin=2em,labelindent=0pt,itemindent=0pt}");
    lines.push("\\setlist[itemize]{leftmargin=1.5em,labelindent=0pt}");
  }

  if (style.columns && style.columns > 1) {
    lines.push("");
    lines.push("% Inkwell multi-column layout");
    lines.push("\\usepackage{multicol}");
    lines.push(`\\newcommand{\\inkwellcolumns}{${style.columns}}`);
  }

  if (style["caption-style"] === "above") {
    lines.push("");
    lines.push("% Inkwell caption position (above floats). Uses the caption");
    lines.push("% package (loaded by the built-in templates); floatrow is avoided");
    lines.push("% because it is incompatible with the float package the templates load.");
    lines.push("\\usepackage{caption}");
    lines.push("\\captionsetup[table]{position=top}");
    lines.push("\\captionsetup[figure]{position=top}");
  }

  return lines.join("\n");
}

/** The generated preamble for a document, or "" when no style keys are set. */
export function generatePreambleText(text: string): string {
  const style = parseInkwellStyle(text);
  const preamble = generatePreamble(style);
  return preamble.trim() ? preamble : "";
}

const GENERATED_PREAMBLE_BEGIN = "% --- Inkwell generated preamble (from frontmatter inkwell: options) ---";
const GENERATED_PREAMBLE_END = "% --- end Inkwell generated preamble ---";

/**
 * Merge the generated preamble into a Pandoc template's text, immediately
 * before the template's `$for(header-includes)$` loop (falling back to a
 * bare `$header-includes$` variable, then to `\begin{document}`). The
 * document's own header-includes therefore stay in the output AND render
 * after the generated block, so document commands win.
 *
 * Returns `injected: false` when the template has no recognizable
 * injection point; the caller should fall back to -H.
 */
export function injectPreambleIntoTemplate(
  templateText: string,
  preamble: string
): { text: string; injected: boolean } {
  const block = `${GENERATED_PREAMBLE_BEGIN}\n${preamble}\n${GENERATED_PREAMBLE_END}\n`;

  const markers = [
    /^\$for\(header-includes\)\$/m,
    /^\$header-includes\$/m,
    /^\\begin\{document\}/m,
  ];
  for (const marker of markers) {
    const m = templateText.match(marker);
    if (m && m.index !== undefined) {
      const text =
        templateText.slice(0, m.index) + block + templateText.slice(m.index);
      return { text, injected: true };
    }
  }
  return { text: templateText, injected: false };
}

export function writePreambleFile(
  text: string,
  cacheDir: string
): string | undefined {
  const preamble = generatePreambleText(text);
  if (!preamble) return undefined;

  const file = path.join(cacheDir, "inkwell-preamble.tex");
  fs.writeFileSync(file, preamble, "utf-8");
  return file;
}
