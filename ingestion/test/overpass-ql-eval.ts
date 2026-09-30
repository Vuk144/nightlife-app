/**
 * A tiny evaluator for the Overpass QL SUBSET that
 * `../src/sources/osm-overpass/query.ts#buildOverpassQuery` emits, so tests can
 * ask "does the production query fetch THIS element?" against real tags
 * instead of string-matching the query text.
 *
 * Supported (exactly what the builder produces):
 *   nwr["k"](area.bg);            key present (any value)
 *   nwr["k"="v"](area.bg);        exact value
 *   nwr["k"~"re"](area.bg);       regex on the value
 *   nwr["k"~"re",i](area.bg);     case-insensitive regex
 *   node|way|relation(id:1,2,…);  explicit ids
 *
 * Every element is assumed to lie inside the query area. Anything else in a
 * clause line throws, so a future builder change cannot be silently
 * mis-evaluated.
 */

export interface QlElement {
  type: "node" | "way" | "relation";
  id: number;
  tags: Record<string, string>;
}

type Filter =
  | { key: string; kind: "has" }
  | { key: string; kind: "eq"; value: string }
  | { key: string; kind: "re"; re: RegExp };

type Clause = { kind: "area"; filters: Filter[]; line: string } | { kind: "ids"; type: QlElement["type"]; ids: Set<number>; line: string };

const FILTER = /\["([^"]+)"(?:(=|~)"([^"]*)"(,i)?)?\]/y;

function parseFilters(body: string, line: string): Filter[] {
  const filters: Filter[] = [];
  FILTER.lastIndex = 0;
  let pos = 0;
  while (pos < body.length) {
    FILTER.lastIndex = pos;
    const m = FILTER.exec(body);
    if (!m) throw new Error(`overpass-ql-eval: unsupported filter syntax in: ${line}`);
    const [, key, op, value, ci] = m;
    if (!op) filters.push({ key, kind: "has" });
    else if (op === "=") filters.push({ key, kind: "eq", value });
    else filters.push({ key, kind: "re", re: new RegExp(value, ci ? "i" : "") });
    pos = FILTER.lastIndex;
  }
  return filters;
}

/** Every union clause of a built query. */
export function parseClauses(query: string): Clause[] {
  const clauses: Clause[] = [];
  for (const raw of query.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line === "(" || line === ");" || line.startsWith("[out:") || line.startsWith("area(") || line.startsWith("out ")) continue;
    const area = /^nwr(.*)\(area\.bg\);$/.exec(line);
    if (area) {
      clauses.push({ kind: "area", filters: parseFilters(area[1], line), line });
      continue;
    }
    const ids = /^(node|way|relation)\(id:([0-9,]+)\);$/.exec(line);
    if (ids) {
      clauses.push({ kind: "ids", type: ids[1] as QlElement["type"], ids: new Set(ids[2].split(",").map(Number)), line });
      continue;
    }
    throw new Error(`overpass-ql-eval: unsupported clause: ${line}`);
  }
  return clauses;
}

function filterMatches(f: Filter, tags: Record<string, string>): boolean {
  const v = tags[f.key];
  if (v === undefined) return false;
  if (f.kind === "has") return true;
  if (f.kind === "eq") return v === f.value;
  return f.re.test(v);
}

/** The clause lines of `query` that would return `element` (empty = not fetched). */
export function matchingClauses(query: string, element: QlElement): string[] {
  return parseClauses(query)
    .filter((c) =>
      c.kind === "ids"
        ? c.type === element.type && c.ids.has(element.id)
        : c.filters.every((f) => filterMatches(f, element.tags)),
    )
    .map((c) => c.line);
}

export function queryFetches(query: string, element: QlElement): boolean {
  return matchingClauses(query, element).length > 0;
}
