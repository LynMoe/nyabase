/**
 * Barrel for backwards-compatible imports.
 *
 * New code should import from the specific module:
 *   - WS payloads: `./agent-messages.js`
 *   - REST request schemas: `./rest-schema.js`
 */
export * from './agent-messages.js';
export * from './rest-schema.js';
