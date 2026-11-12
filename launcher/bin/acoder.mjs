#!/usr/bin/env node
import { main } from '../lib/cli.mjs';
import { LAUNCH_ENABLED } from '../lib/enabled.mjs';
import { adapters, providers } from '../lib/registries.mjs';

process.exitCode = await main(process.argv.slice(2), process.env, { adapters, providers, launchEnabled: LAUNCH_ENABLED });
