/**
 * Finding a registered entry type, and the two refusals that mean it was not found.
 *
 * **An unknown name is not the same failure as an unknown version.** The first means the caller is
 * in the wrong project or misspelled a name, so the message lists the names that exist; the second
 * means the name is right and the version is not, so the message says where versions start and
 * points at the command that shows them.
 *
 * **Shared rather than written twice.** `asc types show` and `asc record --scaffold` look up the
 * same type in the same store and can fail in the same two ways, so a caller who mistypes a name
 * gets the same sentence whichever of the two they typed. Two copies of these messages would say
 * the same thing right up until one of them was edited -- and the caller most likely to be reading
 * both is the one who would not notice that they had stopped agreeing.
 */

import { findType, type Store, type TypeVersionRow } from '@ascend/store';
import { refusal } from './errors.js';
import { knownNames } from './register-document.js';

/**
 * The version asked for, or the latest version when none is.
 *
 * **Refuses rather than returning `undefined`**, because "found nothing" is never a state a caller
 * can act on -- it has two different explanations needing two different sentences, and every call
 * site was writing both by hand. Returning the row and letting the caller decide would put the
 * choice of sentence back where it was duplicated.
 *
 * An omitted `version` means "the latest", a decision the store makes once (`registry.ts`) rather
 * than one each caller re-derives with its own `ORDER BY`.
 */
export function requireType(store: Store, name: string, version?: number): TypeVersionRow {
  const row = findType(store.db, name, version);

  if (row === undefined) {
    throw refusal(
      version === undefined
        ? `There is no entry type named '${name}' in this project. ${knownNames(store.db)}`
        : `Entry type '${name}' has no version ${String(version)}. ` +
            `Versions are numbered from 1 without gaps; ` +
            `run 'asc types show ${name}' to see the latest.`,
    );
  }

  return row;
}
