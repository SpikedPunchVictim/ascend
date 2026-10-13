import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildIndex,
  findType,
  INDEX_FILE,
  openIndex,
  STORE_DIR,
  type SqlDatabase,
  type Store,
} from '@ascend/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { TypeDocument } from '../src/document.js';
import { registerDocument } from '../src/register-document.js';

/**
 * `registerDocument` unit-tested directly against a real store, the same way
 * `errors.test.ts` tests the error boundary directly -- no CLI subprocess and no `dist/`
 * build, because nothing here needs argv parsing, streams or an exit code: the behaviour
 * under test lives entirely between this function and the store.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-register-document-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/**
 * The store as this suite uses it: a ROOT to write through, and a reader over the index.
 *
 * **`db` is a getter that opens the index fresh on every access, and that is what the flip changed
 * here.** `registerDocument` used to take a `Store` and write into it, so a handle taken once
 * described everything the calls that followed had done. Now it takes the tree's root and appends
 * to the tree first, so the index is a *derived* thing that a later read has to reopen -- a handle
 * from before a write is a handle that cannot see it, and one shared across a whole test would pass
 * or fail on the order the assertions happened to run in.
 *
 * The handles are collected rather than closed at each read, because a getter cannot close its own:
 * every one is closed when the body returns, which is the same lifetime the old single handle had.
 */
interface Fixture {
  readonly root: string;
  readonly indexFile: string;
  readonly db: SqlDatabase;
}

const withStore = (body: (store: Fixture) => void): void => {
  // `root` is the TREE directory, not the project: it is what `registerDocument` appends lines to,
  // and the project directory around it is only where the index lives.
  const root = join(tempDir(), STORE_DIR);
  mkdirSync(root, { recursive: true });
  const indexFile = join(root, INDEX_FILE);
  // Built from the empty tree, so every test starts from a project whose index is current --
  // without which `dryRun` would refuse rather than preview (E12.4: a read never builds).
  buildIndex(root, indexFile, { now: AT });

  const opened: Store[] = [];
  const store: Fixture = {
    root,
    indexFile,
    get db(): SqlDatabase {
      const handle = openIndex(root, indexFile);
      opened.push(handle);
      return handle.db;
    },
  };

  try {
    body(store);
  } finally {
    for (const handle of opened) handle.close();
  }
};

const AT = '2026-09-17T10:00:00.000Z';
const LATER = '2026-09-17T11:00:00.000Z';
const THIRD = '2026-09-17T12:00:00.000Z';

const document = (widgetDescription: string, extra: Partial<TypeDocument> = {}): TypeDocument => ({
  name: 'widget_reviewed',
  properties: [{ name: 'widget_kind', type: 'string', description: widgetDescription }],
  ...extra,
});

describe('asc-v7t -- per-property prose on re-registering an existing type', () => {
  it('reports `prose-updated`, not `unchanged`, when only an inline property description changed', () => {
    withStore((store) => {
      const created = registerDocument(store.root, store.indexFile, document('ORIGINAL'), {
        registeredAt: AT,
        dryRun: false,
      });
      expect(created.outcome).toBe('created');

      const second = registerDocument(store.root, store.indexFile, document('UPDATED'), {
        registeredAt: LATER,
        dryRun: false,
      });

      // The bug reported `unchanged` here while leaving the stored prose at 'ORIGINAL' --
      // the weakest possible signal for a dropped edit.
      expect(second.outcome).toBe('prose-updated');
      expect(second.version).toBe(created.version);

      const stored = findType(store.db, 'widget_reviewed', created.version);
      expect(stored?.prose['widget_kind']).toBe('UPDATED');
    });
  });

  it('does not drop the inline property prose when a top-level field changes too', () => {
    withStore((store) => {
      const created = registerDocument(store.root, store.indexFile, document('ORIGINAL'), {
        registeredAt: AT,
        dryRun: false,
      });

      // The second reproduction step from the bead: a top-level `description` is ALSO new,
      // which used to make the command report `prose-updated` while the property prose
      // underneath stayed at 'ORIGINAL' -- a claimed success for work that was dropped.
      const second = registerDocument(
        store.root,
        store.indexFile,
        document('THIRD', { description: 'a brand new top-level description' }),
        { registeredAt: THIRD, dryRun: false },
      );

      expect(second.outcome).toBe('prose-updated');
      const stored = findType(store.db, 'widget_reviewed', created.version);
      expect(stored?.prose['widget_kind']).toBe('THIRD');
      expect(stored?.description).toBe('a brand new top-level description');
    });
  });

  it('is idempotent -- re-registering the exact same document twice reports `unchanged`', () => {
    withStore((store) => {
      registerDocument(store.root, store.indexFile, document('ORIGINAL'), {
        registeredAt: AT,
        dryRun: false,
      });
      const again = registerDocument(store.root, store.indexFile, document('ORIGINAL'), {
        registeredAt: LATER,
        dryRun: false,
      });

      expect(again.outcome).toBe('unchanged');
    });
  });

  it('the top-level `prose` map still overrides an inline description for the same property', () => {
    // Precedence must match `toStorage`'s create path (inline first, top-level overrides), or
    // create and update would disagree about which spelling wins for one property.
    withStore((store) => {
      const created = registerDocument(
        store.root,
        store.indexFile,
        document('inline wins here', { prose: { widget_kind: 'CREATE-TIME OVERRIDE' } }),
        { registeredAt: AT, dryRun: false },
      );
      expect(findType(store.db, 'widget_reviewed', created.version)?.prose['widget_kind']).toBe(
        'CREATE-TIME OVERRIDE',
      );

      registerDocument(
        store.root,
        store.indexFile,
        document('inline still loses', { prose: { widget_kind: 'UPDATE-TIME OVERRIDE' } }),
        { registeredAt: LATER, dryRun: false },
      );
      expect(findType(store.db, 'widget_reviewed', created.version)?.prose['widget_kind']).toBe(
        'UPDATE-TIME OVERRIDE',
      );
    });
  });
});

describe('asc-bli.2/.3 -- guidance on a document', () => {
  const GUIDANCE = {
    purpose: 'why widgets are reviewed',
    analysis_questions: ['which kinds fail review most?'],
    interpretation_notes: 'widget_kind is omitted for bundles',
    review_after: 30,
  } as const;

  it('stores guidance when the document creates the type', () => {
    withStore((store) => {
      const created = registerDocument(store.root, store.indexFile, document('k', GUIDANCE), {
        registeredAt: AT,
        dryRun: false,
      });
      expect(findType(store.db, 'widget_reviewed', created.version)?.guidance).toEqual(GUIDANCE);
    });
  });

  it('editing only purpose is prose-updated: the hash is byte-identical and no version is minted', () => {
    // The load-bearing regression test the bead names. If guidance ever reached the hash, this
    // would report `created` at version 2.
    withStore((store) => {
      const created = registerDocument(store.root, store.indexFile, document('k', GUIDANCE), {
        registeredAt: AT,
        dryRun: false,
      });
      const edited = registerDocument(
        store.root,
        store.indexFile,
        document('k', { ...GUIDANCE, purpose: 'a sharper reason' }),
        { registeredAt: LATER, dryRun: false },
      );

      expect(edited.outcome).toBe('prose-updated');
      expect(edited.version).toBe(created.version);
      expect(edited.typeHash).toBe(created.typeHash);
      expect(findType(store.db, 'widget_reviewed', created.version)?.guidance.purpose).toBe(
        'a sharper reason',
      );
    });
  });

  it('is unchanged when the guidance already matches, including a question list in the same order', () => {
    withStore((store) => {
      registerDocument(store.root, store.indexFile, document('k', GUIDANCE), {
        registeredAt: AT,
        dryRun: false,
      });
      const again = registerDocument(store.root, store.indexFile, document('k', GUIDANCE), {
        registeredAt: LATER,
        dryRun: false,
      });
      expect(again.outcome).toBe('unchanged');
    });
  });

  it('keeps guidance the document does not mention: omission is not a request to clear', () => {
    withStore((store) => {
      registerDocument(store.root, store.indexFile, document('k', GUIDANCE), {
        registeredAt: AT,
        dryRun: false,
      });
      registerDocument(store.root, store.indexFile, document('k', { review_after: 50 }), {
        registeredAt: LATER,
        dryRun: false,
      });
      expect(findType(store.db, 'widget_reviewed', 1)?.guidance).toEqual({
        ...GUIDANCE,
        review_after: 50,
      });
    });
  });

  it('a dry run reports prose-updated for a guidance edit and writes nothing', () => {
    withStore((store) => {
      registerDocument(store.root, store.indexFile, document('k', GUIDANCE), {
        registeredAt: AT,
        dryRun: false,
      });
      const preview = registerDocument(
        store.root,
        store.indexFile,
        document('k', { ...GUIDANCE, review_after: 99 }),
        {
          registeredAt: LATER,
          dryRun: true,
        },
      );
      expect(preview.outcome).toBe('prose-updated');
      expect(findType(store.db, 'widget_reviewed', 1)?.guidance.review_after).toBe(30);
    });
  });
});

/**
 * `asc-6jf` asked this question first and answered it with a warning; `asc-4f2w` (`dogfood/0075`)
 * changed the answer, so these are that suite's cases re-asked of the new rule.
 *
 * A document is the thing that says what a version keeps, so a version that omitted a guidance
 * field used to drop it -- silently, until `asc-6jf` made the drop audible. Audible was still
 * wrong: the field was never meant to go anywhere, and `note` lost its own guidance that way when
 * v1's `text` became v2's `body`, leaving the brief a recorder reads rendering the project's
 * last-resort type exactly like the one type that is deliberately without guidance. The store now
 * carries a superseded version's prose forward per field -- what a document declares wins, every
 * field it does not mention is inherited, `updateTypeProse`'s rule for an edit -- so the drop this
 * suite used to hear cannot happen, in whole or in part.
 */
describe('asc-6jf / asc-4f2w -- a new version against the guidance of the one it supersedes', () => {
  const bumped = (extra: Partial<TypeDocument> = {}): TypeDocument => ({
    name: 'widget_reviewed',
    properties: [
      { name: 'widget_kind', type: 'string' },
      { name: 'reviewer', type: 'string' },
    ],
    ...extra,
  });

  const register = (store: Fixture, doc: TypeDocument, at: string, dryRun = false) =>
    registerDocument(store.root, store.indexFile, doc, { registeredAt: at, dryRun });

  it('carries a field the new version omits forward, and says nothing about it', () => {
    withStore((store) => {
      register(store, document('k', { review_after: 30 }), AT);
      const bump = register(store, bumped(), LATER);

      expect(findType(store.db, 'widget_reviewed', 2)?.guidance.review_after).toBe(30);
      expect(bump.warnings).toEqual([]);
    });
  });

  it('carries every field of the block forward, not only the first', () => {
    withStore((store) => {
      register(store, document('k', { review_after: 30, purpose: 'why' }), AT);
      register(store, bumped(), LATER);

      expect(findType(store.db, 'widget_reviewed', 2)?.guidance).toEqual({
        purpose: 'why',
        review_after: 30,
      });
    });
  });

  it('takes the document literally when it declares the field, whatever the value', () => {
    withStore((store) => {
      register(store, document('k', { review_after: 30 }), AT);
      register(store, bumped({ review_after: 60 }), LATER);

      expect(findType(store.db, 'widget_reviewed', 2)?.guidance.review_after).toBe(60);
    });
  });

  it('says nothing and carries nothing when the previous version declared no guidance', () => {
    withStore((store) => {
      register(store, document('k'), AT);
      const bump = register(store, bumped(), LATER);

      expect(findType(store.db, 'widget_reviewed', 2)?.guidance).toEqual({});
      expect(bump.warnings).toEqual([]);
    });
  });

  it('carries the block forward on a dry run too, so the preview is of the write that follows', () => {
    withStore((store) => {
      register(store, document('k', { review_after: 30 }), AT);
      const preview = register(store, bumped(), LATER, true);

      expect(preview.warnings).toEqual([]);
      // The preview is a rollback, so nothing was written and the assertion is about the real run
      // that follows it matching what was previewed.
      expect(findType(store.db, 'widget_reviewed', 2)).toBeUndefined();
      register(store, bumped(), LATER);
      expect(findType(store.db, 'widget_reviewed', 2)?.guidance.review_after).toBe(30);
    });
  });
});

describe('asc-w0b2 -- prose written to a version that is not the latest', () => {
  /**
   * Two shapes of one type, so one name holds two versions.
   *
   * `v1` is what a document exported BEFORE the bump looks like, and that is the whole setup: the
   * store resolves a document by the hash of its shape and not by recency, so a stale file lands on
   * version 1 however many versions have been minted since. `asc types export` has no `--version`
   * flag, so a file on disk outliving a bump is ordinary rather than careless.
   */
  const v1 = (description: string): TypeDocument => ({
    name: 'widget_reviewed',
    properties: [{ name: 'widget_kind', type: 'string', description }],
  });

  const v2 = (description: string): TypeDocument => ({
    name: 'widget_reviewed',
    properties: [
      { name: 'widget_kind', type: 'string', description },
      { name: 'reviewer', type: 'string' },
    ],
  });

  const register = (store: Fixture, doc: TypeDocument, at: string, dryRun = false) =>
    registerDocument(store.root, store.indexFile, doc, { registeredAt: at, dryRun });

  /** The arrangement every case below starts from: version 1 exists, version 2 is the latest. */
  const twoVersions = (store: Fixture): void => {
    register(store, v1('ORIGINAL'), AT);
    register(store, v2('ORIGINAL'), LATER);
  };

  it('warns, naming both versions and what to do, when the shape resolves to an older one', () => {
    withStore((store) => {
      twoVersions(store);
      const stale = register(store, v1('EDITED'), THIRD);

      // Every value the command prints is correct. That is the point of the case: the outcome is
      // true and the version is true, and neither says that nobody reading the type by name will
      // see the prose that was just written.
      expect(stale.outcome).toBe('prose-updated');
      expect(stale.version).toBe(1);

      expect(stale.warnings).toHaveLength(1);
      const [warning] = stale.warnings;
      expect(warning).toMatch(
        /version 1 of widget_reviewed, so that is where its prose was written/,
      );
      expect(warning).toMatch(/Version 2 is the latest/);
      expect(warning).toMatch(/asc types show widget_reviewed --version 1/);
      expect(warning).toMatch(/asc types export widget_reviewed/);
    });
  });

  it('says nothing when the resolved version IS the latest', () => {
    withStore((store) => {
      register(store, v1('ORIGINAL'), AT);
      expect(register(store, v1('EDITED'), LATER).warnings).toEqual([]);
    });
  });

  it('says nothing on an idempotent re-run of a stale document, which writes nothing', () => {
    withStore((store) => {
      twoVersions(store);
      const again = register(store, v1('ORIGINAL'), THIRD);
      // Not merely quiet -- nothing happened. A warning here would fire on every run of a command
      // that changed no fact, which is how a real warning becomes one a reader learns to skip.
      expect(again.outcome).toBe('unchanged');
      expect(again.warnings).toEqual([]);
    });
  });

  it('warns on a dry run too, which is when the document can still be fixed', () => {
    withStore((store) => {
      twoVersions(store);
      expect(register(store, v1('EDITED'), THIRD, true).warnings).toHaveLength(1);
    });
  });

  it('leaves version 2’s prose alone, which is the fact the warning exists to report', () => {
    withStore((store) => {
      twoVersions(store);
      register(store, v1('EDITED'), THIRD);
      expect(findType(store.db, 'widget_reviewed', 1)?.prose['widget_kind']).toBe('EDITED');
      expect(findType(store.db, 'widget_reviewed', 2)?.prose['widget_kind']).toBe('ORIGINAL');
    });
  });
});
