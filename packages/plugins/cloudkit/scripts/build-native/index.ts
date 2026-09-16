#!/usr/bin/env bun

import { main } from './build-native';

export * from './build-native';

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CloudKit native build failed');
    process.exitCode = 1;
  });
