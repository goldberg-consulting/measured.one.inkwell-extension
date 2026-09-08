import { Parser } from "htmlparser2";
import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export interface HtmlSafetyLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxNodes: number;
  maxDepth: number;
}

export const HTML_SAFETY_LIMITS: Readonly<HtmlSafetyLimits> = Object.freeze({
  maxInputBytes: 2 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024,
  maxNodes: 20_000, maxDepth: 128,
});

export class HtmlSafetyLimitError extends Error {
  constructor(limit: keyof HtmlSafetyLimits) {
    super(`Generated HTML exceeds the ${limit} rendering limit.`);
    this.name = "HtmlSafetyLimitError";
  }
}

const allowedTags = new Set("a abbr aside b bdi bdo blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var".split(" "));
const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const rawTextTags = new Set("script style title textarea iframe xmp noembed noframes".split(" "));
const allowedClasses = /^(?:citation(?:-missing|-preview-notice)?|csl-[a-z0-9-]+|references(?:-[a-z0-9-]+)?|hanging-indent|unnumbered|smallcaps|math-display|footnotes?|footnote-(?:ref|back)|inkwell-(?:table(?:-[a-z0-9-]+)?|reference-heading|raw-table-notice)|table-preset-(?:booktabs|grid|plain|zebra|compact))$/;
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const hasControl = (text: string, allowWhitespace = false): boolean => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 127 || code < 32 && (!allowWhitespace || ![9, 10, 13].includes(code))) return true;
  }
  return false;
};

function limitsFor(options: Partial<HtmlSafetyLimits>): HtmlSafetyLimits {
  const limits = { ...HTML_SAFETY_LIMITS, ...options };
  for (const name of Object.keys(limits) as Array<keyof HtmlSafetyLimits>) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) throw new TypeError(`Invalid HTML safety limit: ${name}`);
  }
  return limits;
}

class Budget {
  input = 0;
  output = 0;
  nodes = 0;
  readonly inlineTags: string[] = [];
  constructor(readonly limits: HtmlSafetyLimits) {}
  consume(name: "input" | "output" | "nodes", amount: number): void {
    this[name] += amount;
    const key = name === "input" ? "maxInputBytes" : name === "output" ? "maxOutputBytes" : "maxNodes";
    if (this[name] > this.limits[key]) throw new HtmlSafetyLimitError(key);
  }
}

/** URLs are entity-decoded by the HTML parser before this check. Image URLs
 * must stay relative: the host subsequently resolves them through its project
 * containment policy. Raw HTML cannot request remote, data, or file images. */
function safeUrl(value: string, image: boolean): string | undefined {
  value = value.trim();
  if (!value || hasControl(value) || /[\s\\]/.test(value) || value.startsWith("/")) return undefined;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  if (scheme) return !image && ["https", "http", "mailto"].includes(scheme) ? value : undefined;
  // Reject encoded control characters, backslashes, and traversal too. The
  // browser and a later image-path resolver must agree about the path.
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return undefined; }
  if (hasControl(decoded) || /[\s\\]/.test(decoded) || decoded.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return undefined;
  if (decoded.split(/[/?#]/).includes("..")) return undefined;
  return value;
}

function length(value: string, maximum = 4096, negative = false): boolean {
  const match = value.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|pt|em|rem|%|cm|mm|in)?$/);
  if (!match || !match[2] && Number(match[1]) !== 0) return false;
  const number = Number(match[1]);
  return Number.isFinite(number) && number <= maximum && number >= (negative ? -maximum : 0);
}

/** Keep only presentation tokens used by body tables and CSL references.
 * No CSS functions, escapes, comments, custom selectors, or URL-bearing values
 * survive. In particular this cannot style webview chrome or load resources. */
export function sanitizeHtmlStyle(style: string): string {
  if (style.length > 4096) return "";
  const declarations: string[] = [];
  for (const declaration of style.split(";")) {
    const match = declaration.trim().match(/^([a-z-]+)\s*:\s*([^:;]+)$/i);
    if (!match) continue;
    const property = match[1].toLowerCase(), value = match[2].trim();
    if (hasControl(value) || /[\\(){}!@/]/.test(value)) continue;
    let valid = false;
    if (["text-align"].includes(property)) valid = /^(?:left|right|center|justify)$/.test(value);
    else if (property === "vertical-align") valid = /^(?:top|middle|bottom|baseline)$/.test(value);
    else if (property === "caption-side") valid = /^(?:top|bottom)$/.test(value);
    else if (["font-style", "--inkwell-table-caption-style"].includes(property)) valid = /^(?:normal|italic)$/.test(value);
    else if (property === "font-variant") valid = /^(?:normal|small-caps)$/.test(value);
    else if (["font-weight", "--inkwell-table-header-weight"].includes(property)) valid = /^(?:normal|bold|400|700)$/.test(value);
    else if (property === "line-height") valid = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) && Number(value) >= 0.5 && Number(value) <= 4;
    else if (["color", "background-color", "--inkwell-table-header-background", "--inkwell-table-stripe-color", "--inkwell-table-rule-color"].includes(property)) {
      valid = /^(?:#[a-f0-9]{3}|#[a-f0-9]{6}|transparent|currentColor|black|white)$/i.test(value);
    } else if (["font-size", "--inkwell-table-font-size", "--inkwell-table-rule-thickness", "--inkwell-table-padding-horizontal", "--inkwell-table-padding-vertical"].includes(property)) valid = length(value, 64);
    else if (["width", "--inkwell-table-width"].includes(property)) valid = value === "auto" || length(value);
    else if (["--inkwell-reference-entry-space", "--inkwell-reference-indent"].includes(property)) valid = length(value, 65536);
    else if (["margin-left", "padding-left"].includes(property)) valid = length(value, 16);
    else if (property === "text-indent") valid = length(value, 16, true);
    if (valid) declarations.push(`${property}:${value}`);
  }
  return declarations.length ? `${declarations.join(";")};` : "";
}

function attributesFor(tag: string, attributes: Record<string, string>): string {
  const safe: string[] = [];
  for (const [name, raw] of Object.entries(attributes).slice(0, 128)) {
    if (raw.length > 4096 || hasControl(raw, true)) continue;
    let value: string | undefined;
    if (["title", "lang", "aria-label"].includes(name)) value = raw;
    else if (name === "dir" && /^(?:ltr|rtl|auto)$/.test(raw)) value = raw;
    else if (name === "id" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(raw)
      && !/^(?:pane-|compile-|run-|log-|font-|pdf-|print-|inkwell-|article-content$|typography-notice$)/.test(raw)) value = raw;
    else if (name === "class") value = raw.split(/\s+/).filter(part => allowedClasses.test(part)).join(" ") || undefined;
    else if (name === "style") value = sanitizeHtmlStyle(raw) || undefined;
    else if (name === "role" && /^(?:doc-bibliography|doc-biblioentry|doc-biblioref|doc-endnotes|doc-noteref|doc-backlink|note|region)$/.test(raw)) value = raw;
    else if (name === "data-cites" && /^[\w:.+/-]+(?:[ \t]+[\w:.+/-]+)*$/.test(raw)) value = raw;
    else if (/^data-inkwell-(?:artifact|block)$/.test(name)) value = raw;
    else if (["span", "div"].includes(tag) && name === "data-inkwell-math" && /^\d{1,6}$/.test(raw)) value = raw;
    else if (tag === "a" && name === "href") value = safeUrl(raw, false);
    else if (tag === "img" && name === "src") value = safeUrl(raw, true);
    else if (tag === "img" && name === "alt") value = raw;
    else if (["td", "th"].includes(tag) && ["colspan", "rowspan"].includes(name) && /^\d{1,3}$/.test(raw) && Number(raw) >= 1) value = raw;
    else if (tag === "th" && name === "scope" && /^(?:row|col|rowgroup|colgroup)$/.test(raw)) value = raw;
    else if (["img", "col"].includes(tag) && ["width", "height", "span"].includes(name) && /^\d{1,4}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 4096) value = raw;
    else if (tag === "ol" && name === "start" && /^-?\d{1,6}$/.test(raw)) value = raw;
    else if (tag === "details" && name === "open") value = "";
    else if (tag === "div" && name === "tabindex" && raw === "0" && attributes.class?.split(/\s+/).includes("inkwell-table-scroll")) value = "0";
    if (value !== undefined) safe.push(` ${name}="${escapeHtml(value)}"`);
  }
  return safe.join("");
}

function sanitize(input: string, budget: Budget, inline: boolean): string {
  budget.consume("input", Buffer.byteLength(input));
  const parts: string[] = [];
  const emit = (value: string): void => { budget.consume("output", Buffer.byteLength(value)); parts.push(value); };
  // markdown-it emits separate opening and closing html_inline tokens. A parser
  // drops unmatched closing tags, so retain only a single validated allowed end
  // tag here; implied parser closes are omitted for the corresponding opener.
  const closing = inline ? input.match(/^<\/([a-z][a-z0-9]*)\s*>$/i) : undefined;
  if (closing) {
    const name = closing[1].toLowerCase();
    budget.consume("nodes", 1);
    if (allowedTags.has(name) && !voidTags.has(name)) emit(`</${name}>`);
    return parts.join("");
  }
  const stack: Array<{ name: string; suppressed: boolean }> = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      budget.consume("nodes", 1);
      if (stack.length >= budget.limits.maxDepth) throw new HtmlSafetyLimitError("maxDepth");
      const suppressed = Boolean(stack.at(-1)?.suppressed) || !allowedTags.has(name);
      stack.push({ name, suppressed });
      if (!suppressed) emit(`<${name}${attributesFor(name, attributes)}>`);
    },
    onclosetag(name, implied) {
      const node = stack.pop();
      if (node && !node.suppressed && !voidTags.has(name) && (!inline || !implied)) emit(`</${name}>`);
    },
    ontext(text) { if (!stack.at(-1)?.suppressed) emit(escapeHtml(text)); },
    // Comments, declarations, processing instructions, and foreign/active
    // element content have no output path.
  }, { xmlMode: false, decodeEntities: true, recognizeSelfClosing: false });
  parser.end(input);
  return parts.join("");
}

/** Sanitize one complete raw HTML fragment, never already-rendered Markdown. */
export function sanitizeRawHtml(input: string, options: Partial<HtmlSafetyLimits> = {}): string {
  return sanitize(input, new Budget(limitsFor(options)), false);
}

const installed = new WeakSet<MarkdownIt>();

/** Intercept only raw HTML renderer tokens. Ordinary Markdown, code, escaped
 * markup, and math text retain their original renderer and bytes. Raw inline
 * script/foreign contents are skipped through their closing tag, even when
 * markdown-it parsed their contents as ordinary inline tokens. */
export function installSafeHtmlRendering(md: MarkdownIt, options: Partial<HtmlSafetyLimits> = {}): void {
  if (installed.has(md)) return;
  const limits = limitsFor(options);
  installed.add(md);
  const renderer = md.renderer;
  let active: Budget | undefined;
  const render = renderer.render;
  const renderInline = renderer.renderInline;
  const within = <T>(work: () => T): T => {
    const previous = active;
    active ||= new Budget(limits);
    try { return work(); } finally { active = previous; }
  };
  renderer.render = (...args) => within(() => render.apply(renderer, args));
  renderer.renderInline = (tokens, ...args) => within(() => {
    const filtered: Token[] = [];
    let suppressed: { name: string; depth: number } | undefined;
    for (const token of tokens) {
      const tag = token.type === "html_inline" ? token.content.match(/^<(\/?)([a-z][a-z0-9-]*)(?=[\s/>])/i) : undefined;
      const name = tag?.[2].toLowerCase();
      if (suppressed) {
        active!.consume("input", Buffer.byteLength(token.content));
        active!.consume("nodes", 1);
        if (name === suppressed.name) {
          if (tag![1]) { if (--suppressed.depth === 0) suppressed = undefined; }
          else if (!rawTextTags.has(name)) {
            if (++suppressed.depth > limits.maxDepth) throw new HtmlSafetyLimitError("maxDepth");
          }
        }
        continue;
      }
      if (name && !tag![1] && !allowedTags.has(name)) {
        active!.consume("input", Buffer.byteLength(token.content));
        active!.consume("nodes", 1);
        if (!voidTags.has(name) && !(["svg", "math"].includes(name) && /\/\s*>$/.test(token.content))) suppressed = { name, depth: 1 };
        continue;
      }
      if (name && allowedTags.has(name) && !voidTags.has(name)) {
        const stack = active!.inlineTags;
        if (tag![1]) {
          const opening = stack.lastIndexOf(name);
          if (opening >= 0) stack.splice(opening);
        } else {
          if (stack.length >= limits.maxDepth) throw new HtmlSafetyLimitError("maxDepth");
          stack.push(name);
        }
      }
      filtered.push(token);
    }
    return renderInline.call(renderer, filtered, ...args);
  });
  renderer.rules.html_block = (tokens, index) => sanitize(tokens[index].content, active || new Budget(limits), false);
  renderer.rules.html_inline = (tokens, index) => sanitize(tokens[index].content, active || new Budget(limits), true);
}
