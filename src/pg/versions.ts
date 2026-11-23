import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isJsonObject, type JsonValue } from '../json.js';

const readVersion = async (file: string, name: string): Promise<string | undefined> => {
  try {
    const parsed: JsonValue = JSON.parse(await readFile(file, 'utf8'));
    return isJsonObject(parsed) && parsed.name === name && typeof parsed.version === 'string'
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The installed version of package `name`, as resolved from mdql itself, or undefined when
 * it is not installed. Packages that don't export `package.json` are found by walking up from
 * their resolved entry file.
 */
export const packageVersion = async (name: string): Promise<string | undefined> => {
  let dir: string;
  try {
    dir = dirname(createRequire(import.meta.url).resolve(name));
  } catch {
    return undefined;
  }
  for (;;) {
    const version = await readVersion(join(dir, 'package.json'), name);
    if (version !== undefined) {
      return version;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};
