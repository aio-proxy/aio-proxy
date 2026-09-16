#!/usr/bin/env bun

import { cloudKitReleaseGatePassed } from './release-cloudkit-gate';

export { cloudKitReleaseGatePassed };

// The release workflow runs this file and reads the printed answer; scripts/release.ts imports the
// same function for its publish set.
if (import.meta.main) console.log(await cloudKitReleaseGatePassed());
