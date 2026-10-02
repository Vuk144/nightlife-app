/**
 * Entry point for `npm run sync:osm` (PLAN ONLY by default; `-- --commit` to
 * apply). All logic lives in `./sync/osm-cli.ts`.
 */

import { runOsmSyncCli } from "./sync/osm-cli.ts";

runOsmSyncCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`Unexpected error: ${(error as Error).message}`);
    process.exitCode = 1;
  },
);
