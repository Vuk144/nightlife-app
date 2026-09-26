/**
 * Shared GIGS TIX HTML helpers (`../../src/events/adapters/gigstix-html.ts`).
 *
 * The event and venue parser tests exercise these only through the fixtures,
 * which all use the plain-hyphen title suffix, property-before-content meta
 * tags and no noise that could collide with a lookup. These pin the branches
 * the fixtures never reach.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanGigstixTitle,
  firstMatch,
  metaContent,
  stripNoise,
} from "../../src/events/adapters/gigstix-html.ts";

test("cleanGigstixTitle: every hyphen / en-dash suffix variant is removed, case-insensitively, after entity decoding", () => {
  for (const raw of [
    "Kamelot - GIGS TIX Srbija - gigstix.com",
    "Kamelot &#8211; GIGS TIX Srbija - gigstix.com",
    "Kamelot - GIGS TIX Srbija &#8211; gigstix.com",
    "Kamelot &ndash; GIGS TIX Srbija &ndash; gigstix.com",
    "Kamelot - gigstix.com",
    "Kamelot &#8211; gigstix.com",
    "\n  Kamelot - gigs tix srbija - GIGSTIX.COM \n",
  ]) {
    assert.equal(cleanGigstixTitle(raw), "Kamelot", JSON.stringify(raw));
  }
});

test("cleanGigstixTitle: only the trailing site suffix is removed — separators inside the event name survive", () => {
  // The long suffix must be tried before its " - gigstix.com" tail, or this
  // would leave "Rock - Pop - GIGS TIX Srbija".
  assert.equal(cleanGigstixTitle("Rock - Pop - GIGS TIX Srbija - gigstix.com"), "Rock - Pop");
  assert.equal(cleanGigstixTitle("Rock &amp; Pop"), "Rock & Pop");
});

test("metaContent: matches property= or name=, in either attribute order, and entity-decodes the value", () => {
  assert.equal(metaContent('<meta property="og:image" content="a.jpg" />', "og:image"), "a.jpg");
  assert.equal(metaContent("<meta content='b.jpg' property='og:image'>", "og:image"), "b.jpg");
  assert.equal(metaContent('<meta name="og:image" content="c.jpg">', "og:image"), "c.jpg");
  assert.equal(
    metaContent('<meta property="og:description" content="A &#8211; B &amp; C">', "og:description"),
    "A – B & C",
  );
  // a longer property sharing the prefix is not a match
  assert.equal(
    metaContent('<meta property="og:image:width" content="800"><meta property="og:image" content="x.jpg">', "og:image"),
    "x.jpg",
  );
  assert.equal(metaContent('<meta property="og:description" content="">', "og:description"), "");
  assert.equal(metaContent("<p>no meta</p>", "og:description"), null);
});

test("stripNoise: script / style / svg / comments are removed, so an icon's or commented-out <title> never wins the title lookup", () => {
  const html =
    "<body><svg><title>icon</title></svg><!-- <title>old</title> -->" +
    '<SCRIPT type="text/javascript">var t = "<title>js</title>";\n</SCRIPT><style>\n.x{}</style>' +
    "<title>Real</title></body>";
  assert.equal(firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, stripNoise(html)), "Real");
  // <noscript> is not <script>; an unclosed block is left alone rather than eating the rest
  assert.equal(stripNoise("<noscript>n</noscript>"), "<noscript>n</noscript>");
  assert.equal(stripNoise("<p>a</p><script>no end"), "<p>a</p><script>no end");
});
