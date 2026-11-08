#!/usr/bin/env node
// The eminzo command. See cli/src/main.js.
import { main } from '../src/main.js';

process.exitCode = await main(process.argv.slice(2));
