/**
 * LaTeX math in chat markdown. Providers disagree on delimiters: Claude writes `$x$` and
 * `$$x$$`, GPT models often write `\(x\)` and `\[x\]`. remark-math only reads dollars, so
 * `normalizeMarkdownMath` rewrites the source before parsing:
 *
 * - `\(` `\)` `\[` `\]` become `$$`. Both are two characters, so source offsets that
 *   renderers and task-list edits rely on still line up with the original text.
 * - A single `$` only opens math when Pandoc's rule allows it: the opener is followed by
 *   a non-space, the closer is preceded by a non-space and not followed by a digit. Any
 *   other `$` ("$5 and $10", `$HOME`) is swapped for a placeholder of the same length that
 *   `remarkMathPresentation` turns back into `$` after parsing.
 *
 * Code spans and fences are left untouched. KaTeX itself is loaded on first use.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

type RehypePlugin = NonNullable<ReactMarkdownOptions["rehypePlugins"]>[number];

/** A Unicode noncharacter: never meaningful in model output, one UTF-16 unit like `$`. */
const DOLLAR_PLACEHOLDER = "﷐";
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const BLANK_LINE_SPLIT = /(\n[ \t]*\n)/;

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/** Index just past the backtick run closing the code span at `start`, or -1. */
function codeSpanEnd(text: string, start: number): number {
  let runLength = 0;
  while (text[start + runLength] === "`") runLength++;
  let index = start + runLength;
  while (index < text.length) {
    if (text[index] !== "`") {
      index++;
      continue;
    }
    let closeLength = 0;
    while (text[index + closeLength] === "`") closeLength++;
    if (closeLength === runLength) return index + closeLength;
    index += closeLength;
  }
  return -1;
}

/** Index of the `\` that starts `\<close>` after `from`, honoring escapes, or -1. */
function findEscapedClose(text: string, from: number, close: string): number {
  for (let index = from; index < text.length - 1; index++) {
    if (text[index] !== "\\") continue;
    if (text[index + 1] === close) return index;
    index++;
  }
  return -1;
}

/** Index of a single `$` that may close inline math opened before `from`, or -1. */
function findDollarClose(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
    } else if (char === "`") {
      // A code span opened inside the math candidate wins, as it does in micromark.
      const end = codeSpanEnd(text, index);
      if (end !== -1) index = end - 1;
      else while (text[index + 1] === "`") index++;
    } else if (char === "$") {
      if (text[index + 1] === "$") {
        index++;
      } else if (!isWhitespace(text[index - 1]) && !/[0-9]/.test(text[index + 1] ?? "")) {
        return index;
      }
    }
  }
  return -1;
}

function normalizeParagraph(paragraph: string): string {
  const chars = paragraph.split("");
  // Once a `$` finds no closer, no later `$` in the paragraph will either.
  let hasDollarClose = true;
  let index = 0;
  while (index < paragraph.length) {
    const char = paragraph[index];
    if (char === "`") {
      const end = codeSpanEnd(paragraph, index);
      if (end !== -1) {
        index = end;
        continue;
      }
      while (paragraph[index] === "`") index++;
      continue;
    }
    if (char === "\\") {
      const next = paragraph[index + 1];
      const close = next === "(" ? ")" : next === "[" ? "]" : undefined;
      const closeIndex = close ? findEscapedClose(paragraph, index + 2, close) : -1;
      if (closeIndex > index + 2) {
        chars[index] = chars[index + 1] = "$";
        chars[closeIndex] = chars[closeIndex + 1] = "$";
        index = closeIndex + 2;
        continue;
      }
      index += 2;
      continue;
    }
    if (char !== "$") {
      index++;
      continue;
    }
    if (paragraph[index + 1] === "$") {
      // Display or double-dollar inline math: skip to its closing `$$` so dollars inside
      // stay as written. An unclosed `$$` is still streaming and keeps its text.
      const close = paragraph.indexOf("$$", index + 2);
      index = close === -1 ? index + 2 : close + 2;
      continue;
    }
    const closeIndex =
      hasDollarClose && !isWhitespace(paragraph[index + 1])
        ? findDollarClose(paragraph, index + 1)
        : -1;
    if (closeIndex === -1) {
      if (!isWhitespace(paragraph[index + 1])) hasDollarClose = false;
      chars[index] = DOLLAR_PLACEHOLDER;
      index++;
      continue;
    }
    index = closeIndex + 1;
  }
  return chars.join("");
}

function normalizeProse(prose: string): string {
  if (!/[$\\]/.test(prose)) return prose;
  return prose
    .split(BLANK_LINE_SPLIT)
    .map((part, index) => (index % 2 === 1 ? part : normalizeParagraph(part)))
    .join("");
}

/** Rewrites math delimiters for remark-math. The result has the same length as `text`. */
export function normalizeMarkdownMath(text: string): string {
  if (!/[$\\]/.test(text)) return text;
  const lines = text.split(/(?<=\n)/);
  let output = "";
  let prose = "";
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      output += line;
      const close = FENCE_OPEN.exec(line);
      if (
        close?.[1]?.[0] === fence.char &&
        close[1].length >= fence.length &&
        line.slice(close[0].length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open?.[1]) {
      output += normalizeProse(prose) + line;
      prose = "";
      fence = { char: open[1][0] ?? "`", length: open[1].length };
      continue;
    }
    prose += line;
  }
  return output + normalizeProse(prose);
}

interface MathAstNode {
  type?: string;
  value?: unknown;
  url?: unknown;
  title?: unknown;
  alt?: unknown;
  position?: { start: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
  children?: MathAstNode[];
}

function restoreDollars(node: MathAstNode): void {
  for (const key of ["value", "url", "title", "alt"] as const) {
    const value = node[key];
    if (typeof value === "string" && value.includes(DOLLAR_PLACEHOLDER)) {
      node[key] = value.replaceAll(DOLLAR_PLACEHOLDER, "$");
    }
  }
  node.children?.forEach(restoreDollars);
}

function promoteDisplayMath(node: MathAstNode, source: string): void {
  const only = node.type === "paragraph" && node.children?.length === 1 ? node.children[0] : null;
  const start = only?.type === "inlineMath" ? only.position?.start.offset : undefined;
  if (only && start !== undefined && source.startsWith("$$", start)) {
    only.data = {
      ...only.data,
      hProperties: { ...only.data?.hProperties, className: ["language-math", "math-display"] },
    };
    return;
  }
  for (const child of node.children ?? []) promoteDisplayMath(child, source);
}

/**
 * Runs after remark-math: puts back the dollars `normalizeMarkdownMath` set aside, and shows
 * a paragraph holding nothing but `$$x$$` (or a one-line `\[x\]`) as display math.
 */
export function remarkMathPresentation() {
  return (tree: MathAstNode, file: { value?: unknown }) => {
    restoreDollars(tree);
    promoteDisplayMath(tree, typeof file.value === "string" ? file.value : "");
  };
}

interface MathHastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MathHastNode[];
  value?: string;
}

function hastText(node: MathHastNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");
}

function mathClasses(node: MathHastNode): unknown[] {
  const className = node.properties?.className;
  return node.tagName === "code" && Array.isArray(className) ? className : [];
}

/**
 * Wraps each math element in a span whose `data-markdown-copy` holds the TeX source, so a
 * copied selection pastes `$x$` instead of KaTeX's rendered glyphs. Runs before rehype-katex,
 * which then replaces the wrapped element.
 */
function rehypeMathCopySource() {
  const wrap = (node: MathHastNode) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      const code = child.tagName === "pre" ? child.children?.[0] : child;
      const classes = code ? mathClasses(code) : [];
      if (!code || !classes.includes("language-math")) {
        wrap(child);
        return child;
      }
      const tex = hastText(code).trim();
      const display = child !== code || classes.includes("math-display");
      return {
        type: "element",
        tagName: "span",
        properties: { dataMarkdownCopy: display ? `$$\n${tex}\n$$` : `$${tex}$` },
        children: [child],
      };
    });
  };
  return wrap;
}

/** True when the normalized source has anything remark-math or ` ```math ` would render. */
export function hasMarkdownMath(normalizedText: string): boolean {
  return /\$|^[ \t]*(?:`{3,}|~{3,})[ \t]*math\b/m.test(normalizedText);
}

let mathRehypePlugins: RehypePlugin[] | null = null;
let mathRehypePluginsLoad: Promise<void> | null = null;
const mathRehypePluginsListeners = new Set<() => void>();

/** Loads KaTeX (script and styles) once. Resolves when `useMathRehypePlugins` can render. */
export function loadMathRehypePlugins(): Promise<void> {
  mathRehypePluginsLoad ??= Promise.all([
    import("rehype-katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([{ default: rehypeKatex }]) => {
    mathRehypePlugins = [
      rehypeMathCopySource,
      // Unicode text inside math is common in chat; KaTeX's strict mode only logs about it.
      [rehypeKatex, { strict: false }],
    ];
    for (const listener of mathRehypePluginsListeners) listener();
  });
  return mathRehypePluginsLoad;
}

function subscribeMathRehypePlugins(listener: () => void) {
  mathRehypePluginsListeners.add(listener);
  return () => mathRehypePluginsListeners.delete(listener);
}

/**
 * The KaTeX rehype plugins once loaded, else null. Asking with `needed` starts the load;
 * until it finishes, math renders as its code source.
 */
export function useMathRehypePlugins(needed: boolean): RehypePlugin[] | null {
  const plugins = useSyncExternalStore(
    subscribeMathRehypePlugins,
    () => mathRehypePlugins,
    () => mathRehypePlugins,
  );
  useEffect(() => {
    if (needed && !plugins) void loadMathRehypePlugins();
  }, [needed, plugins]);
  return plugins;
}
