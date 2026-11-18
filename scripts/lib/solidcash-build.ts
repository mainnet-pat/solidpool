// Which SolidCash the contracts are built with: the @solidcash packages npm installs, at the
// version package.json pins. Every artifact names the compiler's version too, so a deployment
// records it beside the pools it made.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export interface SolidcashBuild {
  version: string;
  /** The compiler package's own directory. */
  directory: string;
}

/** The compiler package's directory and version. */
export function solidcashBuild(): SolidcashBuild {
  const project = realpathSync(new URL('../..', import.meta.url).pathname);
  const directory = realpathSync(join(project, 'node_modules', '@solidcash', 'solidc'));
  const { version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version: string };
  return { version, directory };
}

/** The line that names the build, for the scripts that print it. */
export const describeSolidcash = ({ version, directory }: SolidcashBuild): string => `SolidCash ${version}, at ${directory}`;
