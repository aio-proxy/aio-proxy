#!/usr/bin/env bun

import { main } from './verify-oauth-sync';

export { main };

if (import.meta.main)
  await main().catch(() => {
    process.exitCode = 1;
  });
