/**
 * Re-exported so every existing importer of these from `./json-fields.js` keeps working unchanged.
 *
 * They moved to `@ascend/store` in `asc-i5tj`, together with the JSONL/type-document parsers that
 * use them -- the store owns the whole format, reader as well as writer, and `align` forbids
 * `store -> cli`. `entry-document.ts` still imports them through this module; that module carries
 * the full rationale for what the three functions are and why they are shared.
 */
export { describeValue, fieldError, isJsonObject } from '@ascend/store';
