#!/usr/bin/env node
// oclif entry point. Commands are discovered from ./dist/commands (see the
// `oclif` block in package.json) -- none exist yet; they land in E4.
import { execute } from '@oclif/core';

await execute({ dir: import.meta.url });
