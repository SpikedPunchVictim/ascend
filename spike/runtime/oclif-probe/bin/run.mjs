#!/usr/bin/env node
// oclif's normal dev-mode entry point.
import { execute } from '@oclif/core';

await execute({ dir: import.meta.url });
