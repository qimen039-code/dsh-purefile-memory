#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

main().catch((error) => {
  process.stderr.write(`ERROR ${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
