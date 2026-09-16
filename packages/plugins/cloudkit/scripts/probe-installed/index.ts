#!/usr/bin/env bun

import { main } from './probe-installed';

export * from './probe-installed';

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CloudKit installed probe failed');
    process.exitCode = 1;
  });
