/**
 * src/core/monitoring/sentry-sdk.ts
 *
 * The part of @sentry/browser this app uses, as the module sentry.ts imports
 * dynamically. `import('@sentry/browser')` would keep the whole package --
 * Session Replay and rrweb included, ~450 KB -- because nothing can be
 * tree-shaken out of a namespace loaded at run time. Named re-exports can.
 */

export { init, captureException } from '@sentry/browser';
