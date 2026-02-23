import * as fs from "fs";
import * as path from "path";

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
  "header-includes"?: string[];
}

export function parseInkwellStyle(text: string): InkwellStyle {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const style: InkwellStyle = {};

  const inkwellBlock = extractYamlBlock(yaml, "inkwell");
  if (!inkwellBlock) return style;

  const codeBg = extractValue(inkwellBlock, "code-bg");
  if (codeBg) style["code-bg"] = codeBg;

  const codeBorder = extractValue(inkwellBlock, "code-border");
  if (codeBorder === "true") style["code-border"] = true;

  const codeFontSize = extractValue(inkwellBlock, "code-font-size");
  if (codeFontSize) style["code-font-size"] = codeFontSize;

  const codeRounded = extractValue(inkwellBlock, "code-rounded");
  if (codeRounded === "true") style["code-rounded"] = true;

  const tables = extractValue(inkwellBlock, "tables");
  if (tables === "booktabs" || tables === "grid" || tables === "plain") {
    style.tables = tables;
  }

  const tableFontSize = extractValue(inkwellBlock, "table-font-size");
  if (tableFontSize) style["table-font-size"] = tableFontSize;

  const tableStripe = extractValue(inkwellBlock, "table-stripe");
  if (tableStripe === "true") style["table-stripe"] = true;

  const hangingIndent = extractValue(inkwellBlock, "hanging-indent");
  if (hangingIndent === "true") style["hanging-indent"] = true;

  const columns = extractValue(inkwellBlock, "columns");
  if (columns) style.columns = parseInt(columns, 10) || undefined;

  const captionStyle = extractValue(inkwellBlock, "caption-style");
  if (captionStyle === "above" || captionStyle === "below") {
    style["caption-style"] = captionStyle;
  }

  return style;
}

function extractYamlBlock(yaml: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}:\\s*$`, "m");
  const match = yaml.match(pattern);
  if (!match) return undefined;

  const start = match.index! + match[0].length;
  const lines = yaml.substring(start).split("\n");
  const block: string[] = [];

  for (const line of lines) {
    if (line.match(/^\S/) && line.trim()) break;
    block.push(line);
  }

  return block.join("\n");
}

function extractValue(block: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s+${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m");
  const match = block.match(pattern);
  return match ? match[1].trim() : undefined;
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
        "linewidth=" + (style["code-border"] ? "0.4pt" : "0pt") + "," +
        "linecolor=black!20," +
        "innerleftmargin=8pt,innerrightmargin=8pt," +
        "innertopmargin=6pt,innerbottommargin=6pt," +
        "skipabove=6pt,skipbelow=6pt]}{\\end{mdframed}}");
    }

    if (style["code-font-size"]) {
      const size = style["code-font-size"];
      const valid = ["tiny", "scriptsize", "footnotesize", "small", "normalsize"];
      if (valid.includes(size)) {
        lines.push(`\\DefineVerbatimEnvironment{Highlighting}{Verbatim}{commandchars=\\\\\\{\\},fontsize=\\${size}}`);
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
      const valid = ["tiny", "scriptsize", "footnotesize", "small", "normalsize"];
      if (valid.includes(size)) {
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
    lines.push("\\usepackage{floatrow}");
    lines.push("\\floatsetup[table]{capposition=top}");
    lines.push("\\floatsetup[figure]{capposition=top}");
  }

  return lines.join("\n");
}

export function writePreambleFile(
  text: string,
  cacheDir: string
): string | undefined {
  const style = parseInkwellStyle(text);
  const preamble = generatePreamble(style);
  if (!preamble.trim()) return undefined;

  const file = path.join(cacheDir, "inkwell-preamble.tex");
  fs.writeFileSync(file, preamble, "utf-8");
  return file;
}
