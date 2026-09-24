/**
 * Handlers as strict YAML 1.2 (asc-6ola.13; decision b474b6f6).
 *
 * YAML was chosen for comments, regexes without doubled escapes, and block scalars. Its hazards
 * were measured before it was chosen (spike/handler-format/FINDINGS.md), and each one is closed
 * here rather than documented:
 *
 *   - YAML 1.2 core schema only, so `on:`, `yes:` and `no:` stay strings -- the `on: -> true`
 *     trap is YAML 1.1 behaviour.
 *   - Anchors, aliases, merge keys and explicit tags are refused. Each lets a handler's text say
 *     something other than what it reads as; `!custom` tags were accepted SILENTLY by the parser.
 *   - Duplicate keys are refused: the parser would otherwise keep one and drop the other.
 *   - `1.10` still parses as the number 1.1. Core's type check refuses it where a string was
 *     meant, but the message quotes the parsed 1.1, not the text written.
 *
 * Everything about what a handler MEANS is `compileHandler`'s, in `@ascend/core`. This file
 * only turns text into plain data, and refuses text whose data would not be what it looks like.
 */

import { compileHandler, HandlerError, type CompiledHandler } from '@ascend/core';
import { isScalar, parseDocument, visit } from 'yaml';

/** A handler file larger than this is refused unread. The spike's largest was under 1 KB. */
export const MAX_HANDLER_BYTES = 64 * 1024;

const refuse = (message: string): never => {
  throw new HandlerError(message);
};

/** Parse handler text to plain data, refusing every construct listed above. */
export function parseHandlerYaml(source: string): unknown {
  if (source.length > MAX_HANDLER_BYTES) {
    refuse(`handler is ${String(source.length)} bytes, over ${String(MAX_HANDLER_BYTES)}`);
  }
  const document = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    prettyErrors: false,
  });
  const [error] = document.errors;
  if (error !== undefined) refuse(`not valid YAML: ${error.message.split('\n')[0] ?? ''}`);
  const [warning] = document.warnings;
  if (warning !== undefined) refuse(`YAML warning: ${warning.message.split('\n')[0] ?? ''}`);

  visit(document, {
    Alias() {
      refuse('aliases (*name) are refused: write the value out');
    },
    Node(_key, node) {
      if (node.anchor !== undefined) {
        refuse(`anchors (&${node.anchor}) are refused`);
      }
      if (node.tag !== undefined) refuse(`explicit tags (${node.tag}) are refused`);
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === '<<') refuse('merge keys (<<) are refused');
    },
  });
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

/** Parse and compile one handler's text. Throws `HandlerError` with the reason. */
export function loadHandler(source: string): CompiledHandler {
  return compileHandler(parseHandlerYaml(source));
}
