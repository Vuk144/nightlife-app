import { relative } from "node:path";
import { loadConfig, loadEnvFile } from "./config.ts";
import { createServiceClient } from "./supabase.ts";
import { TARGETS } from "./targets.ts";
import { ingestVenuesForTarget } from "./ingest-venues.ts";
import { CATEGORY_LABELS } from "./classify.ts";
import type { IngestSummary, VenueAction, VenueCategory } from "./types.ts";

function parseArgs(argv: string[]): { dryRun: boolean; verbose: boolean } {
  return {
    dryRun: argv.includes("--dry-run"),
    verbose: argv.includes("--verbose"),
  };
}

function printSummary(label: string, summary: IngestSummary): void {
  const pad = (value: number): string => String(value).padStart(5);
  console.log(`\n${label}`);
  console.log(`  Fetched:   ${pad(summary.fetched)}`);
  console.log(`  Inserted:  ${pad(summary.inserted)}`);
  console.log(`  Updated:   ${pad(summary.updated)}`);
  console.log(`  Unchanged: ${pad(summary.unchanged)}`);
  console.log(`  Skipped:   ${pad(summary.skipped)}`);
  console.log(`  Invalid:   ${pad(summary.invalid)}`);
  console.log(`  Excluded:  ${pad(summary.excluded)}`);
}

const CATEGORY_ORDER: VenueCategory[] = [
  "nightclub",
  "concert_hall",
  "bar",
  "pub_brewery",
  "kafana",
  "nightlife_venue",
  "other_nightlife",
];

function printCategoryBreakdown(actions: VenueAction[]): void {
  const accepted = actions.filter(
    (a) => a.kind === "insert" || a.kind === "update" || a.kind === "unchanged",
  );
  if (accepted.length === 0) return;

  const counts = new Map<VenueCategory, number>();
  for (const a of accepted) {
    if (!a.category) continue;
    counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  }

  console.log(`\n  Accepted venues by category (${accepted.length} total):`);
  for (const category of CATEGORY_ORDER) {
    const n = counts.get(category);
    if (n) console.log(`    ${String(n).padStart(4)}  ${CATEGORY_LABELS[category]}`);
  }

  const rescued = accepted.filter((a) => /RESCUED/.test(a.note ?? ""));
  if (rescued.length > 0) {
    console.log(`\n  ${rescued.length} accepted via the curated rescue list:`);
    for (const a of rescued) console.log(`    - ${a.name} (${a.externalId})`);
  }
}

const ACTION_ORDER: VenueAction["kind"][] = [
  "update",
  "unchanged",
  "insert",
  "skip",
  "invalid",
  "excluded",
];

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}~` : value;
}

function actionRow(action: VenueAction): string {
  const coords =
    action.latitude != null && action.longitude != null
      ? `${action.latitude.toFixed(5)}, ${action.longitude.toFixed(5)}`
      : "-";
  const cat = action.category ? action.category : "";
  const extra = action.note ?? action.address ?? "";
  const flag = action.review ? "! " : "  ";
  return `  ${flag}${action.kind.padEnd(9)} ${truncate(action.name, 28).padEnd(28)} ${action.externalId.padEnd(15)} ${cat.padEnd(16)} ${truncate(extra, 56)}`;
}

function printActions(actions: VenueAction[], verbose: boolean): void {
  if (actions.length === 0) return;

  const sorted = [...actions].sort(
    (a, b) =>
      ACTION_ORDER.indexOf(a.kind) - ACTION_ORDER.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );

  // Default view: everything except plain (non-flagged) inserts, which are
  // summarised by category above. `--verbose` shows every row.
  const shown = verbose
    ? sorted
    : sorted.filter((a) => a.kind !== "insert" || a.review);
  const hiddenInserts = sorted.length - shown.length;

  console.log(
    `\n  ${"".padEnd(2)}${"action".padEnd(9)} ${"name".padEnd(28)} ${"osm id".padEnd(15)} ${"category".padEnd(16)} address / note`,
  );
  console.log(`  ${"-".repeat(118)}`);
  for (const action of shown) console.log(actionRow(action));
  if (hiddenInserts > 0) {
    console.log(
      `  .. ${hiddenInserts} plain insert(s) not shown — pass --verbose for the full list`,
    );
  }

  const flagged = sorted.filter((a) => a.review);
  if (flagged.length > 0) {
    console.log(`\n  ${flagged.length} record(s) flagged for review (marked "!"):`);
    for (const a of flagged) {
      console.log(`    ! ${a.kind} "${a.name}" (${a.externalId}) — ${a.note ?? ""}`);
    }
  }
}

async function main(): Promise<void> {
  const { dryRun, verbose } = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let config;
  try {
    const env = loadEnvFile();
    const shown = relative(process.cwd(), env.path) || env.path;
    if (env.existed) {
      console.log(
        `env: loaded ${shown}` +
          (env.parsedKeys.length > 0
            ? ` (keys: ${env.parsedKeys.join(", ")})`
            : " (file present but no keys parsed)"),
      );
    } else {
      console.log(`env: no file at ${shown} — using the process environment`);
    }
    config = loadConfig();
  } catch (error) {
    console.error(`\nConfiguration error: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const supabase = createServiceClient(config);

  if (dryRun) {
    console.log("DRY RUN — fetch + match only, no writes.");
  }

  let hadError = false;
  for (const target of TARGETS) {
    const label = `OpenStreetMap -> ${target.cityName} (${target.countryId})${
      dryRun ? " [dry run]" : ""
    }`;
    try {
      const { summary, actions } = await ingestVenuesForTarget(
        supabase,
        config,
        target,
        { dryRun },
      );
      printSummary(label, summary);
      printCategoryBreakdown(actions);
      printActions(actions, verbose);
    } catch (error) {
      hadError = true;
      console.error(`\n${label}: FAILED\n  ${(error as Error).message}`);
    }
  }

  console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (hadError) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Unexpected error: ${(error as Error).message}`);
  process.exitCode = 1;
});
