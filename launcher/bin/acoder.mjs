#!/usr/bin/env node
import { adapters } from '../adapters/index.mjs';
import { main } from '../lib/cli.mjs';
import { LAUNCH_ENABLED } from '../lib/enabled.mjs';
import { providers } from '../providers/index.mjs';

process.exitCode = await main(process.argv.slice(2), process.env, { adapters, providers, launchEnabled: LAUNCH_ENABLED });
