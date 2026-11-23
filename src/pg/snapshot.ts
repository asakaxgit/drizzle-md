import { createDrizzleMdError } from '../errors.js';
import { packageVersion } from './versions.js';

export const PGLITE = '@electric-sql/pglite';
export const PREPOPULATED = '@electric-sql/pglite-prepopulatedfs';

export interface SnapshotSource {
  /** Installed version of a package, or undefined when it is not installed. */
  readonly version: (name: string) => Promise<string | undefined>;
  /** Loads the prepopulated data directory. */
  readonly load: () => Promise<Blob>;
}

export interface SnapshotChoice {
  /** The data directory to start from, or undefined for a normal initdb start. */
  readonly dataDir: Blob | undefined;
  /** Why the snapshot was not used although it is installed. */
  readonly warning?: string;
}

const defaultSource: SnapshotSource = {
  version: packageVersion,
  load: async () => {
    const { dataDir } = await import('@electric-sql/pglite-prepopulatedfs');
    return dataDir();
  },
};

/**
 * Decides whether PGlite starts from the prepopulated snapshot.
 *
 * - `false`: never.
 * - `undefined` (default): when the snapshot package is installed and its version matches
 *   PGlite's exactly. A mismatch or a failed load falls back to initdb with a warning.
 * - `true`: always; a missing package, a mismatch or a failed load is a `CONFIG` error.
 */
export const chooseSnapshot = async (
  prepopulated: boolean | undefined,
  source: SnapshotSource = defaultSource,
): Promise<SnapshotChoice> => {
  if (prepopulated === false) {
    return { dataDir: undefined };
  }
  const required = prepopulated === true;
  const [pgliteVersion, snapshotVersion] = await Promise.all([
    source.version(PGLITE),
    source.version(PREPOPULATED),
  ]);
  const fail = (message: string, cause?: Error): SnapshotChoice => {
    if (required) {
      throw createDrizzleMdError(
        'CONFIG',
        `prepopulated: true, but ${message}`,
        cause === undefined ? {} : { cause },
      );
    }
    return { dataDir: undefined, warning: `${message}; starting PGlite without the snapshot.` };
  };
  if (snapshotVersion === undefined) {
    return required ? fail(`${PREPOPULATED} is not installed`) : { dataDir: undefined };
  }
  if (snapshotVersion !== pgliteVersion) {
    return fail(
      `${PREPOPULATED} ${snapshotVersion} does not match ${PGLITE} ${pgliteVersion ?? '(not found)'}; install the same version of both`,
    );
  }
  try {
    return { dataDir: await source.load() };
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    return fail(`loading the ${PREPOPULATED} snapshot failed: ${cause.message}`, cause);
  }
};
