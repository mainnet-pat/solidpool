// A production server checks its settings, and asks every server they name, before it serves
// anything (lib/settings-check.ts), as the production build did (next.config.ts): the server reads
// them as it starts, so it checks the settings it runs with, and no build-time shortcut skips it.
// The check is Node's alone: the Edge build drops this branch and its import.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NODE_ENV === 'production') {
    await (await import('./lib/settings-check')).stopWithoutSettings('This server will not start', 'start');
    // Then the factories it would trust on each network it offers, each read through that
    // network's own server, just checked.
    await (await import('./lib/factory-check')).stopOnFactories('This server will not start');
  }
}
