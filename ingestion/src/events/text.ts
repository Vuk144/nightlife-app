/**
 * Small, pure text helpers shared by the event adapters and the engine.
 * No I/O, no clock — safe to use inside `parse()`.
 */

import { createHash } from "node:crypto";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/** Decode the HTML entities that actually occur in this data (named + numeric). */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      safeFromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : whole,
    );
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Remove every tag; does not decode entities or normalise whitespace. */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/** Collapse all whitespace runs to a single space and trim. */
export function collapseWs(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Tags -> text, decoded and whitespace-collapsed onto a single line. */
export function inlineText(html: string): string {
  return collapseWs(decodeEntities(stripTags(html)));
}

/**
 * Tags -> text, but block-level tags become newlines so paragraph structure
 * survives. Blank lines are dropped; each line is whitespace-collapsed.
 */
export function blockText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|section|article|tr)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(withBreaks)
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Deterministic SHA-1 hex digest of a string. */
export function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

/**
 * Lower-cased, de-accented, alphanumeric token list — for keyword and title
 * comparisons. Serbian Latin diacritics are folded (č/ć->c, š->s, ž->z, đ->dj).
 */
export function tokenize(value: string): string[] {
  const folded = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/đ/g, "dj")
    .replace(/[̀-ͯ]/g, "");
  return folded.split(/[^a-z0-9]+/).filter(Boolean);
}
