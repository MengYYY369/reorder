import { closePool } from "./helpers/db";

/**
 * Playwright's `globalTeardown` must point at a module, not an inline function.
 *
 * The data layer holds one pool open for the whole run; ending it here keeps
 * `yarn test:e2e` from hanging on an open handle after the report is written.
 */
export default async function globalTeardown(): Promise<void> {
  await closePool();
}
