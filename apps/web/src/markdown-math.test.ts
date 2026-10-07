import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

import { hasMarkdownMath, normalizeMarkdownMath } from "./markdown-math";

const PLACEHOLDER = "\uFDD0";

describe("normalizeMarkdownMath", () => {
  it.each([
    ["Euler: \\(e^{i\\pi} + 1 = 0\\).", "Euler: $$e^{i\\pi} + 1 = 0$$."],
    ["\\[\n\\int_0^1 x\\,dx\n\\]", "$$\n\\int_0^1 x\\,dx\n$$"],
    ["\\[ a^2 + b^2 = c^2 \\]", "$$ a^2 + b^2 = c^2 $$"],
  ])("rewrites LaTeX delimiters to dollars: %j", (input, expected) => {
    expect(normalizeMarkdownMath(input)).toBe(expected);
  });

  it.each([
    "Inline $x^2$ and $$\\frac{a}{b}$$ math.",
    "$$\nE = mc^2\n$$",
    "A literal \\$5 escape.",
    "Matrix row break $$a \\\\[2pt] b$$ stays put.",
  ])("leaves valid dollar math alone: %j", (input) => {
    expect(normalizeMarkdownMath(input)).toBe(input);
  });

  it.each([
    ["It costs $5 and $10.", `It costs ${PLACEHOLDER}5 and ${PLACEHOLDER}10.`],
    ["Set $HOME and $PATH first.", `Set ${PLACEHOLDER}HOME and ${PLACEHOLDER}PATH first.`],
    ["Pay $ 5 now.", `Pay ${PLACEHOLDER} 5 now.`],
    ["Total $x$5 here.", `Total ${PLACEHOLDER}x${PLACEHOLDER}5 here.`],
  ])("sets aside dollars Pandoc would not read as math: %j", (input, expected) => {
    expect(normalizeMarkdownMath(input)).toBe(expected);
  });

  it("does not pair dollars across paragraphs", () => {
    expect(normalizeMarkdownMath("Costs $5\n\nnow$ ok")).toBe(
      `Costs ${PLACEHOLDER}5\n\nnow${PLACEHOLDER} ok`,
    );
  });

  it("leaves code spans and fences untouched", () => {
    const input = [
      "Run `echo $HOME \\(x\\)` first.",
      "",
      "  ```sh",
      "  echo $PATH \\(y\\)",
      "",
      "  echo $USER",
      "  ```",
      "",
      "Then $a$.",
    ].join("\n");
    expect(normalizeMarkdownMath(input)).toBe(input);
  });

  it("keeps the source length so offsets still match", () => {
    const input = "- [ ] \\(x\\) costs $5\n- [x] `$y` and \\[z\\]";
    expect(normalizeMarkdownMath(input)).toHaveLength(input.length);
  });
});

describe("hasMarkdownMath", () => {
  it("detects normalized math and math fences only", () => {
    expect(hasMarkdownMath(normalizeMarkdownMath("It costs $5."))).toBe(false);
    expect(hasMarkdownMath(normalizeMarkdownMath("Area \\(\\pi r^2\\)."))).toBe(true);
    expect(hasMarkdownMath("```math\nx\n```")).toBe(true);
  });
});

describe("KaTeX packaging", () => {
  it("styles markup from the same KaTeX version rehype-katex renders with", () => {
    // The stylesheet comes from our katex dependency; class names change between versions.
    const require = NodeModule.createRequire(import.meta.url);
    const rehypeKatexRequire = NodeModule.createRequire(require.resolve("rehype-katex"));
    expect(rehypeKatexRequire("katex/package.json").version).toBe(
      require("katex/package.json").version,
    );
  });
});
