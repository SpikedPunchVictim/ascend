import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confusableNames, type PropertySpec, type TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, registeredNames, registerType, type Store } from '../src/index.js';

/**
 * The define-time vocabulary check, exercised through `registerType` rather than through the
 * function that implements it.
 *
 * **Why the public surface.** `warnings` on the returned `RegisteredType` is the contract the CLI
 * already consumes (`asc types define` prints each one with `this.warn`), so driving it here is what
 * makes the store-to-CLI wiring a tested fact instead of a claim. `vocabularyNotes` stays
 * unexported; a unit test against it would also pass with nothing calling it.
 *
 * **The fixtures are the real drift.** EV-drift's five independent `review-completed` definitions
 * disagreed on 44 property names, intersecting on 4 (0.091). `review_stage` against `stage` is not a
 * constructed collision -- it is two real authors naming one slot, and it is exactly what this check
 * exists to surface. A fixture of invented near-misses would prove the string comparison works and
 * nothing about whether the mechanism catches the drift it was built for.
 *
 * **Two of the tests below are the proof that the check reads the registry BEFORE writing to it.**
 * That ordering is not tidiness: read after the insert, this spec's own name is already in
 * `entry_types` and its own properties are already in the stored specs, so both halves would find
 * themselves "already registered" and report nothing. A check that is inert looks exactly like a
 * check that found nothing, so the ordering is asserted rather than commented.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-vocabulary-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-12T08:00:00.000Z';
const LATER = '2026-09-12T09:00:00.000Z';

const withStore = (body: (store: Store) => void): void => {
  const store = openStore({ dir: tempDir() });
  try {
    body(store);
  } finally {
    store.close();
  }
};

const text = (name: string): PropertySpec => ({ name, type: 'text' });

const type = (name: string, properties: readonly PropertySpec[]): TypeSpec => ({
  name,
  properties,
});

/** The vocabulary warnings on a result, separated from the canonicalization ones that share the channel. */
const notes = (warnings: readonly string[]): readonly string[] =>
  warnings.filter((warning) => warning.includes('shares'));

describe('a new type name that overlaps a registered one', () => {
  it('warns, names the registered type, and names the token they share', () => {
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });

      const result = registerType(store.db, type('stage', [text('notes')]), {
        registeredAt: LATER,
      });

      expect(notes(result.warnings)).toHaveLength(1);
      const [note] = notes(result.warnings);
      // The reason is printed, not a score: `'stage'` is checkable by the author in one second,
      // and a bare similarity number is one they would have to take on faith.
      expect(note).toContain("'review_stage'");
      expect(note).toContain("'stage'");
      // The remedy, because a warning that only observes the problem is one the author cannot act on.
      expect(note).toContain('new version');
    });
  });

  it('is silent in a store that holds nothing, so the first definition of a vocabulary never nags', () => {
    withStore((store) => {
      const result = registerType(store.db, type('review_stage', [text('stage')]), {
        registeredAt: AT,
      });

      expect(notes(result.warnings)).toEqual([]);
      // The whole array, not just the vocabulary part: an empty store must produce no warnings at
      // all, which also pins that this check does not add noise of its own.
      expect(result.warnings).toEqual([]);
    });
  });

  it('does not re-warn on a version bump, because the name is not new', () => {
    // This is the warning-fatigue guard, and it is the reason the type-name half is gated on the
    // name being unregistered. `registerType` returns `created` for a new VERSION too, so without
    // the gate every future bump of `stage` would reprint "shares 'stage' with 'review_stage'" --
    // a true sentence, on each bump, until the author stopped reading the channel. A warning that
    // is always present carries no information.
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });
      registerType(store.db, type('stage', [text('notes')]), { registeredAt: LATER });

      const bump = registerType(store.db, type('stage', [text('notes'), text('detail')]), {
        registeredAt: LATER,
      });

      expect(bump.outcome).toBe('created');
      expect(bump.version).toBe(2);
      expect(notes(bump.warnings)).toEqual([]);
    });
  });
});

describe('a new property name that overlaps a registered one', () => {
  it('warns, and this assertion is what proves the check reads the registry BEFORE the insert', () => {
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });

      // Read after the insert, `review_stage` would itself now be a registered property name, the
      // dedup would skip it as "already registered", and this would report nothing. The test
      // distinguishes the two orderings rather than describing which one was chosen.
      const result = registerType(store.db, type('alpha_note', [text('review_stage')]), {
        registeredAt: LATER,
      });

      expect(notes(result.warnings)).toHaveLength(1);
      expect(notes(result.warnings)[0]).toContain("'stage'");
      expect(notes(result.warnings)[0]).toContain('Reuse the registered name');
    });
  });

  it('is silent when the property name is already registered, because reuse is the goal', () => {
    // EV-drift's remedy was "a shared property vocabulary" matched against before registration.
    // Reusing a registered name IS that outcome, so warning about it would be warning about
    // success -- and would train the author to ignore the channel on exactly the behaviour the
    // mechanism is trying to encourage.
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });

      const result = registerType(store.db, type('alpha_note', [text('stage')]), {
        registeredAt: LATER,
      });

      expect(notes(result.warnings)).toEqual([]);
    });
  });

  it('stays silent even when the reused name also resembles a second registered name', () => {
    // The case that actually exercises the skip, and the reason it is there rather than being a
    // restatement of what `confusableNames` already does. `stage_again` is registered, so reusing
    // it is reuse; but it ALSO shares the token `stage` with `stage`, so a check that went
    // straight to `confusableNames` would report it. The skip is what holds that back, and this
    // test is the one that distinguishes the two implementations -- the simpler case above passes
    // either way, because `confusableNames` skips an exact match on its own.
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage'), text('stage_again')]), {
        registeredAt: AT,
      });

      const result = registerType(store.db, type('delta_summary', [text('stage_again')]), {
        registeredAt: LATER,
      });

      expect(notes(result.warnings)).toEqual([]);
      // The counterfactual, asserted rather than described: without the registered-name skip, the
      // same name would be reported. Without this line the test would pass against a check that
      // found nothing at all.
      expect(confusableNames('stage_again', ['stage']).map((m) => m.name)).toEqual(['stage']);
    });
  });

  it('is silent for a different spelling of a registered name, which is half the drift already gone', () => {
    // EV-drift measured 3 snake_case authors against 2 camelCase ones. `reviewKind` and
    // `review_kind` are one name after folding, so the second is reuse rather than drift -- and
    // the warning must not fire, or canonicalization would be reported as a problem by the check
    // that depends on it.
    withStore((store) => {
      registerType(store.db, type('alpha_note', [{ name: 'review_kind', type: 'text' }]), {
        registeredAt: AT,
      });

      // `delta_summary` rather than another `*_note`: two fixture type names sharing a token would
      // trip the type-name half and the assertion below would fail for a reason that has nothing to
      // do with the property spelling under test.
      const result = registerType(
        store.db,
        type('delta_summary', [{ name: 'reviewKind', type: 'text' }]),
        {
          registeredAt: LATER,
        },
      );

      expect(notes(result.warnings)).toEqual([]);
    });
  });

  it('still counts a name that only an earlier VERSION of a type used', () => {
    // The check reads every stored version, not just the latest of each type. A name that appeared
    // in v1 and was dropped in v2 is still a name a caller may be about to reinvent, which is the
    // drift this serves.
    //
    // The property is `stage_detail` rather than a token-free name like `detail`, and that choice is
    // what makes the test able to fail: `detail` shares no token with anything, so a check reading
    // only the latest versions would ALSO stay silent and the test would pass against both
    // implementations. `stage_detail` shares `stage` with a name still registered in v2, so a stale
    // read reports it and a correct read does not. Verified by mutation, not asserted by argument.
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage'), text('stage_detail')]), {
        registeredAt: AT,
      });
      // v2 drops `stage_detail`, so a latest-version-only read would no longer know the name.
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: LATER });

      const result = registerType(store.db, type('alpha_note', [text('stage_detail')]), {
        registeredAt: LATER,
      });

      expect(notes(result.warnings)).toEqual([]);
      // Present rather than absent is the point: the name is registered, so it is NOT reported. A
      // warning here would mean the read had gone stale and had forgotten it.
      const known = registeredNames(store.db);
      expect(known.properties).toContain('stage_detail');
      // The counterfactual: with only v2's names known, the same property WOULD be reported. Without
      // this, the assertion above would pass against a check that never reported anything.
      expect(confusableNames('stage_detail', ['stage']).map((m) => m.name)).toEqual(['stage']);
    });
  });

  it('reports each new property once, and only the ones that actually overlap', () => {
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });

      const result = registerType(
        store.db,
        type('alpha_note', [text('review_stage'), text('unrelated'), text('stage_again')]),
        { registeredAt: LATER },
      );

      // `unrelated` shares nothing and must not appear; `review_stage` and `stage_again` each
      // overlap on `stage` and each get their own note.
      const reported = notes(result.warnings);
      expect(reported).toHaveLength(2);
      expect(reported.join('\n')).not.toContain('unrelated');
    });
  });

  it('says how many matches it did not name, rather than listing three as if they were all', () => {
    // Found by reading the real command's output, not by a test: a name overlapping six registered
    // ones produced a sentence naming three of them, which a reader takes as complete. The withheld
    // count is exactly what tells the author how crowded the vocabulary already is, so the message
    // reports it. The earlier implementation sliced inside `confusableNames`, which is why it had no
    // way to know -- the fix was to uncap the matcher and let this layer decide what to print.
    withStore((store) => {
      for (const suffix of ['a', 'b', 'c', 'd', 'e']) {
        registerType(store.db, type(`stage_${suffix}`, [text('notes')]), { registeredAt: AT });
      }

      const result = registerType(store.db, type('stage', [text('narrative')]), {
        registeredAt: LATER,
      });

      const note = notes(result.warnings).find((warning) => warning.includes('type name'));
      expect(note).toBeDefined();
      // All five share `stage`; the message names three and counts the other two.
      expect(
        confusableNames(
          'stage',
          registeredNames(store.db).types.filter((t) => t !== 'stage'),
        ),
      ).toHaveLength(5);
      expect(note).toContain('and 2 more');
      // Named ones present, unnamed ones absent -- so the count is a real remainder rather than a
      // number printed beside a complete list.
      expect(note).toContain("'stage_a'");
      expect(note).not.toContain("'stage_d'");
      expect(note).not.toContain("'stage_e'");
    });
  });

  it('reads naturally when it names exactly two matches', () => {
    // The conjunction is part of the message, and `'a', and 'b'` reads worse than the plain
    // conjunction -- so the comma is dropped for two. Asserted because it is the shape a caller
    // sees most often.
    withStore((store) => {
      for (const suffix of ['a', 'b']) {
        registerType(store.db, type(`stage_${suffix}`, [text('notes')]), { registeredAt: AT });
      }

      const result = registerType(store.db, type('stage', [text('narrative')]), {
        registeredAt: LATER,
      });

      const note = notes(result.warnings).find((warning) => warning.includes('type name'));
      expect(note).toContain("'stage_a' and 'stage_b'");
      expect(note).not.toContain('more');
    });
  });

  it('speaks in canonical names, matching the warning channel it shares', () => {
    // The stored spec is canonicalized before this check sees it, and the canonicalization warnings
    // on the same array already print folded names. A check that printed the author's raw spelling
    // would disagree with the message printed beside it about the same property.
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });

      const result = registerType(
        store.db,
        type('alpha_note', [{ name: 'stageAgain', type: 'text' }]),
        {
          registeredAt: LATER,
        },
      );

      expect(notes(result.warnings)[0]).toContain("'stage_again'");
      expect(notes(result.warnings)[0]).not.toContain("'stageAgain'");
    });
  });
});

describe('the paths that must not carry the check', () => {
  it('carries no vocabulary notes on `unchanged`, because nothing new was introduced', () => {
    // Deliberate: the `unchanged` early return reports the canonicalization warnings and nothing
    // else. A re-registration introduces no name, so there is nothing for this check to say, and
    // the store's own vocabulary has not moved.
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });
      const first = registerType(store.db, type('stage', [text('notes')]), { registeredAt: LATER });

      const again = registerType(store.db, type('stage', [text('notes')]), { registeredAt: LATER });

      expect(first.outcome).toBe('created');
      expect(again.outcome).toBe('unchanged');
      expect(again.warnings).toEqual([]);
    });
  });

  it('previews the same notes on a dry run, and registers nothing', () => {
    // A dry run is a preview of this registration, so it has to carry the same warnings -- a
    // preview that dropped them would be a preview of a different operation.
    withStore((store) => {
      registerType(store.db, type('review_stage', [text('stage')]), { registeredAt: AT });

      const preview = registerType(store.db, type('stage', [text('notes')]), {
        registeredAt: LATER,
        dryRun: true,
      });

      expect(notes(preview.warnings)).toHaveLength(1);
      // And it left the vocabulary where it found it, so a preview cannot make the next real
      // define think its own name was already taken.
      expect(registeredNames(store.db).types).toEqual(['review_stage']);
    });
  });
});

describe('registeredNames', () => {
  it('folds and deduplicates, so one concept is one entry', () => {
    withStore((store) => {
      registerType(store.db, type('alpha_note', [{ name: 'reviewKind', type: 'text' }]), {
        registeredAt: AT,
      });
      registerType(store.db, type('beta_note', [{ name: 'review_kind', type: 'text' }]), {
        registeredAt: LATER,
      });

      // Stored folded and deduplicated: the two spellings are one name, which is what makes the
      // check's equality test a concept test rather than a string test.
      expect(registeredNames(store.db).properties).toEqual(['review_kind']);
      // Sorted, which is what the ordering guarantee downstream rests on.
      expect(registeredNames(store.db).types).toEqual(['alpha_note', 'beta_note']);
    });
  });
});
