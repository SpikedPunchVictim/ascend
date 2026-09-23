import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findType, openStore, type Store } from '@ascend/store';
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

const withStore = (body: (store: Store) => void): void => {
  const store = openStore({ dir: tempDir() });
  try {
    body(store);
  } finally {
    store.close();
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
      const created = registerDocument(store, document('ORIGINAL'), {
        registeredAt: AT,
        dryRun: false,
      });
      expect(created.outcome).toBe('created');

      const second = registerDocument(store, document('UPDATED'), {
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
      const created = registerDocument(store, document('ORIGINAL'), {
        registeredAt: AT,
        dryRun: false,
      });

      // The second reproduction step from the bead: a top-level `description` is ALSO new,
      // which used to make the command report `prose-updated` while the property prose
      // underneath stayed at 'ORIGINAL' -- a claimed success for work that was dropped.
      const second = registerDocument(
        store,
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
      registerDocument(store, document('ORIGINAL'), { registeredAt: AT, dryRun: false });
      const again = registerDocument(store, document('ORIGINAL'), {
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
        store,
        document('inline wins here', { prose: { widget_kind: 'CREATE-TIME OVERRIDE' } }),
        { registeredAt: AT, dryRun: false },
      );
      expect(findType(store.db, 'widget_reviewed', created.version)?.prose['widget_kind']).toBe(
        'CREATE-TIME OVERRIDE',
      );

      registerDocument(
        store,
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
      const created = registerDocument(store, document('k', GUIDANCE), {
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
      const created = registerDocument(store, document('k', GUIDANCE), {
        registeredAt: AT,
        dryRun: false,
      });
      const edited = registerDocument(
        store,
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
      registerDocument(store, document('k', GUIDANCE), { registeredAt: AT, dryRun: false });
      const again = registerDocument(store, document('k', GUIDANCE), {
        registeredAt: LATER,
        dryRun: false,
      });
      expect(again.outcome).toBe('unchanged');
    });
  });

  it('keeps guidance the document does not mention: omission is not a request to clear', () => {
    withStore((store) => {
      registerDocument(store, document('k', GUIDANCE), { registeredAt: AT, dryRun: false });
      registerDocument(store, document('k', { review_after: 50 }), {
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
      registerDocument(store, document('k', GUIDANCE), { registeredAt: AT, dryRun: false });
      const preview = registerDocument(store, document('k', { ...GUIDANCE, review_after: 99 }), {
        registeredAt: LATER,
        dryRun: true,
      });
      expect(preview.outcome).toBe('prose-updated');
      expect(findType(store.db, 'widget_reviewed', 1)?.guidance.review_after).toBe(30);
    });
  });
});
