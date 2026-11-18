// Run the solidhat CLI from its package entry point.
//
// A package's bin can carry a shebang this container refuses to execute, and the package
// path is stable wherever npm put it, so the scripts go through node instead.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cli = require.resolve('@solidcash/solidhat/cli');
const { status } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(status ?? 1);
