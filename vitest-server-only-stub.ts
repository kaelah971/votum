/**
 * Empty stand-in for Next.js's `server-only` package, used only by vitest.
 * Next.js bundles `server-only` to an empty module; this file mirrors that so
 * server-gated modules can be imported directly in unit tests without being
 * reachable from a Client Component boundary.
 */
const emptyModule = {};
export default emptyModule;
