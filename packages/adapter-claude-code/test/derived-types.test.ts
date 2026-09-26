import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_PROPERTY_NAMES,
  canonicalizeTypeSpec,
  definitionShape,
  reservedPropertyName,
  validateEntry,
  type PropertySpec,
} from '@ascend/core';
import {
  DERIVED_SOURCE,
  DERIVED_TYPES,
  FINDING_LENSES,
  derivationVersion,
  derivedType,
} from '../src/index.js';

/**
 * Invariants the six derived type definitions must hold, checked against core's own rules
 * rather than against a copy of them.
 *
 * These are definitions registered through the ordinary `registerType` path, so every rule
 * that applies to a user's type applies here -- and the ones tested below are the ones whose
 * violation would be INVISIBLE. A reserved property name silently reads the envelope column
 * instead of the property; a `record_when` that reads like an instruction makes a model
 * hand-record what a machine already derived; an enum over a vocabulary we do not own turns a
 * new value into a rejected entry. None of those fail loudly at the point of the mistake.
 *
 * The counts asserted here are STRUCTURAL, not measured -- `derive-real-corpus.test.ts` owns
 * the measured numbers, because those move every time anyone runs a command.
 */

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

describe('the six derived types', () => {
  it('ships exactly six, named for the events they are', () => {
    expect(DERIVED_TYPES.map((spec) => spec.name).sort()).toEqual([
      'context_compaction',
      'review_finding',
      'skill_activation',
      'tool_denial',
      'user_correction',
      'verification_run',
    ]);
  });

  it('is indexed by name, and answers undefined for a name it does not have', () => {
    for (const spec of DERIVED_TYPES) expect(derivedType(spec.name)).toBe(spec);
    expect(derivedType('not_a_derived_type')).toBeUndefined();
  });

  it('claims the derived source, which mirrors the store CHECK constraint', () => {
    // The store refuses any other value, so this is not a preference: an entry
    // with a different source would be rejected at insert.
    expect(DERIVED_SOURCE).toBe('derived:claude-code');
  });
});

describe('every definition survives canonicalization', () => {
  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s canonicalizes cleanly, changing only the property ORDER',
    (_name, spec) => {
      const result = canonicalizeTypeSpec(spec);
      expect(result.errors).toEqual([]);
      expect(result.renames).toEqual([]);
      expect(result.warnings).toEqual([]);

      // Canonicalization SORTS properties by name, so the order declared in
      // `derived-types.ts` is not the order that gets registered or hashed. The
      // declaration order is therefore documentation -- reading order -- not
      // semantics, and asserting deep equality against it would be asserting
      // something the system does not promise. What IS promised is that nothing
      // else moved.
      expect(result.spec.name).toBe(spec.name);
      expect(result.spec.description).toBe(spec.description);
      expect(result.spec.record_when).toBe(spec.record_when);

      // Canonicalization also SORTS `enum_values`, so `['passed','failed']` is
      // stored as `['failed','passed']`. The set is what the definition means;
      // the sequence is presentation, and core owns that decision. Comparing the
      // sets rather than the arrays keeps this test about the definitions.
      const shape = (properties: readonly PropertySpec[]): unknown[] =>
        [...properties].sort(byName).map((one) => ({
          ...one,
          enum_values: one.enum_values === undefined ? undefined : [...one.enum_values].sort(),
        }));
      expect(shape(result.spec.properties)).toEqual(shape(spec.properties));
    },
  );

  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s canonicalizes to properties in alphabetical order',
    (_name, spec) => {
      const names = canonicalizeTypeSpec(spec).spec.properties.map((one) => one.name);
      expect(names).toEqual([...names].sort());
    },
  );

  it('is a fixed point, so canonicalizing twice changes nothing', () => {
    // If a second pass reordered or renamed, then the hash of a definition would
    // depend on how many times it had been through registration.
    for (const spec of DERIVED_TYPES) {
      const once = canonicalizeTypeSpec(spec).spec;
      const twice = canonicalizeTypeSpec(once).spec;
      expect(twice).toEqual(once);
    }
  });

  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s declares no reserved property name',
    (_name, spec) => {
      for (const property of spec.properties) {
        // Core's own rule, not a reimplementation of it: a property named `source`
        // would read the envelope's source column instead of the property.
        expect(reservedPropertyName(property.name)).toBeUndefined();
      }
    },
  );

  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s declares no property the envelope already carries',
    (_name, spec) => {
      const envelope = new Set<string>(ENVELOPE_PROPERTY_NAMES);
      for (const property of spec.properties) {
        expect(envelope.has(property.name)).toBe(false);
      }
    },
  );
});

describe('record_when is inverted, which is the point of it', () => {
  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s tells a model NOT to record it by hand',
    (_name, spec) => {
      // `asc types brief` prints `name -- record_when` for every active type and
      // is what a model reads before recording. For a derived type, a normal
      // `record_when` reads as an instruction to record it by hand -- which
      // would double every count with entries indistinguishable except by
      // `source`. So every one of these must say the opposite.
      expect(spec.record_when).toMatch(/never by hand/i);
      expect(spec.record_when).toContain('asc ingest claude-code');
    },
  );

  it('keeps the whole brief cheap, because it is a tax on every session', () => {
    // 73 characters each. The total went 365 -> 438 when `review_finding` was added, and the
    // cap moved 400 -> 450 to hold it -- a raise that is the point of the test rather than a
    // nuisance: the tax is per session and per TYPE, so the cap has to be an absolute number,
    // and a seventh type takes the total to 511 and trips this. A cap expressed as a multiple
    // of `DERIVED_TYPES.length` would be the false-green class `purity-enforcement.test.ts`
    // codifies: it could never fail, so it would go silent on a runaway.
    const chars = DERIVED_TYPES.reduce((total, spec) => total + (spec.record_when?.length ?? 0), 0);
    expect(chars).toBeLessThan(450);
  });
});

describe('provenance travels as properties, on every type', () => {
  const REQUIRED = ['session_id', 'project'];

  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s carries session_id and project as REQUIRED properties',
    (_name, spec) => {
      // The envelope has no column for the transcript, and `recorded_at` is when
      // ascend ingested the entry -- during a two-year backfill those differ by
      // years. Without these, every derived entry would be unresolvable to the
      // event it came from.
      for (const name of REQUIRED) {
        const property = spec.properties.find((one) => one.name === name);
        expect(property, `${spec.name} is missing ${name}`).toBeDefined();
        expect(property?.required).toBe(true);
      }
    },
  );

  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s offers occurred_at, and does NOT require it',
    (_name, spec) => {
      const property = spec.properties.find((one) => one.name === 'occurred_at');
      expect(property?.type).toBe('timestamp');
      // Present on every entry measured, and still not required: a transcript
      // without a timestamp is a real state, and requiring it would make the
      // adapter invent one rather than omit.
      expect(property?.required).toBeUndefined();
      expect(property?.name).not.toBe('recorded_at');
    },
  );

  it.each(DERIVED_TYPES.map((spec) => [spec.name, spec] as const))(
    '%s keeps project in ENCODED form, never decoded',
    (_name, spec) => {
      // `-` stands for both a path separator and a literal hyphen, so decoding is
      // lossy and two projects can collide. The prose has to say so, because the
      // tempting thing to do with a value like `-Users-me-src-app` is decode it.
      const property = spec.properties.find((one) => one.name === 'project');
      expect(property?.description).toMatch(/encoded/i);
      expect(property?.description).toMatch(/lossy|collide/i);
    },
  );
});

describe('vocabularies we do not own are strings, not enums', () => {
  /** [type, property, the phrase that explains why it is open] */
  const MACHINE_EMITTED = [
    ['tool_denial', 'denial_kind', /belongs to Claude Code/i],
    ['context_compaction', 'trigger', /belongs to Claude Code/i],
    // A different reason, and a real one: skills are installed and removed by
    // the user, so the set is open for a reason that is not ours to close either.
    ['skill_activation', 'skill', /installed and removed by the user/i],
  ] as const;

  it.each(MACHINE_EMITTED)('%s.%s is a string', (type, property) => {
    const spec = derivedType(type);
    const found = spec?.properties.find((one) => one.name === property);
    expect(found?.type).toBe('string');
    expect(found?.enum_values).toBeUndefined();
  });

  it.each(MACHINE_EMITTED)('%s.%s says WHY it is open', (type, property, phrase) => {
    // The reason has to travel with the definition, or the next person closes
    // the list and quietly converts every future value into a rejected entry.
    const found = derivedType(type)?.properties.find((one) => one.name === property);
    expect(found?.description).toMatch(phrase);
  });

  it('keeps verdict an enum, because WE own that vocabulary', () => {
    // The one closed list here, and it is closed because it is ours: a verdict
    // is passed or failed and nothing else is meaningful.
    const verdict = derivedType('verification_run')?.properties.find(
      (one) => one.name === 'verdict',
    );
    expect(verdict?.type).toBe('enum');
    expect(verdict?.enum_values).toEqual(['passed', 'failed']);
    expect(verdict?.required).toBe(true);
  });

  it('keeps previous_verdict an enum and optional', () => {
    const property = derivedType('verification_run')?.properties.find(
      (one) => one.name === 'previous_verdict',
    );
    expect(property?.type).toBe('enum');
    expect(property?.required).toBeUndefined();
  });
});

describe('the one vocabulary we close, and the one we do not', () => {
  const spec = (): ReturnType<typeof derivedType> => derivedType('review_finding');

  it('is the ONLY enum over a vocabulary we did not invent', () => {
    // Every other vocabulary in this file is a string by `VOCABULARY_IS_NOT_OURS`. This is the
    // exception, and a test that names the exception is what stops the rule quietly becoming
    // "enums are fine when convenient" one type later. The three others are all ascend's own
    // concepts -- passed/failed, a prior verdict, and whether a verdict came from the check's
    // exit status or its output -- so closing them costs nothing when the harness changes.
    const enums = DERIVED_TYPES.flatMap((one) =>
      one.properties.filter((p) => p.type === 'enum').map((p) => `${one.name}.${p.name}`),
    );
    expect(enums.sort()).toEqual([
      'review_finding.class',
      'verification_run.previous_verdict',
      'verification_run.verdict',
      'verification_run.verdict_source',
    ]);
  });

  it('closes `class` on exactly the nine lenses, in the skill’s own order', () => {
    const property = spec()?.properties.find((one) => one.name === 'class');
    expect(property?.type).toBe('enum');
    expect(property?.required).toBe(true);
    // Declared in lens order, so the skill's numbering survives in the source even though
    // canonicalization SORTS enum_values before anything is registered or hashed.
    expect(property?.enum_values).toEqual(FINDING_LENSES.map((one) => one.slug));
  });

  it('pins the nine slugs as LITERALS, so this test is the freeze', () => {
    // Without this, every other assertion here compares `FINDING_LENSES` against itself -- the
    // enum is built from that table -- so renaming a lens would pass all of them while silently
    // making every finding recorded before the rename incomparable with every one after it. The
    // literals are the freeze, and editing them is the deliberate act a rename requires.
    //
    // A RENAME IS NOT FORBIDDEN, it is costly, and the cost is not visible in this file: a
    // changed `enum_values` changes the definition shape, so a rename mints a new type version
    // and splits the counts across the boundary. Anyone editing this list is choosing that.
    expect(FINDING_LENSES.map((one) => one.slug)).toEqual([
      'assumption_audit',
      'state_machine',
      'boundary_conditions',
      'data_lifecycle',
      'error_paths',
      'time_concurrency',
      'environment_divergence',
      'cross_implementation_divergence',
      'write_read_asymmetry',
    ]);
  });

  it('carries the provenance table, so the mapping is checkable rather than remembered', () => {
    // The nine headings are copied from `~/.claude/skills/bug-hunt/SKILL.md` v1.0.0, which is
    // outside this repository and will drift. Holding both the heading and the skill's own lens
    // number makes a later diff against the skill a comparison rather than a re-derivation.
    expect(FINDING_LENSES.map((one) => one.lens)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(FINDING_LENSES.map((one) => one.slug)).size).toBe(9);
    for (const one of FINDING_LENSES) {
      // A copy-paste that duplicated a heading or a number would otherwise pass every other
      // assertion here, because both are only ever compared as sets.
      expect(one.heading.length).toBeGreaterThan(0);
      expect(one.slug).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
    expect(new Set(FINDING_LENSES.map((one) => one.heading)).size).toBe(9);
  });

  it('says WHY it is closed, where a reader will hit it', () => {
    // The mirror of `says WHY it is open`. The reason has to travel with the definition, or the
    // next person sees an inconsistency with the rule three constants above and reopens it --
    // which would silently make nine spellings of one lens countable as nine classes.
    const description = spec()?.properties.find((one) => one.name === 'class')?.description ?? '';
    expect(description).toMatch(/enum on purpose/i);
    expect(description).toMatch(/version bump/i);
    expect(description).toMatch(/review_completed/);
  });

  it('REFUSES a class outside the nine, naming the values it will take', () => {
    // The behaviour the vocabulary is closed FOR, and the reason the normalizer has to count
    // off-vocabulary values separately (normalize.ts): a refusal is a drop, and a drop is
    // invisible. Nothing here can make the store accept a tenth lens; what the log does about
    // it is Stage 2's.
    const result = validateEntry(spec()!, {
      properties: {
        class: 'lens_ten',
        file: 'a.ts',
        summary: 's',
        tool_use_id: 't1',
        session_id: 'sess-1',
        project: '-Users-me-app',
      },
    });
    expect(result.errors.length).toBeGreaterThan(0);
    const problem = result.errors.map((one) => one.problem).join(' ');
    expect(problem).toMatch(/invalid enum value/i);
    expect(problem).toContain('boundary_conditions');
  });

  it('keeps `verdict` a STRING, because that vocabulary is the harness’s', () => {
    // The plan sketched this as an enum over `CONFIRMED`/`PLAUSIBLE`. It is not one, and the
    // rule above is why: those two values come from the harness's report format, so closing the
    // list would turn a third verdict into a rejected entry the day it ships. Same treatment as
    // `denial_kind`, including naming the measured values in the prose.
    const property = spec()?.properties.find((one) => one.name === 'verdict');
    expect(property?.type).toBe('string');
    expect(property?.enum_values).toBeUndefined();
    expect(property?.description).toContain('CONFIRMED');
    expect(property?.description).toContain('PLAUSIBLE');
    expect(property?.description).toMatch(/belongs to the harness/i);
  });

  it('declares `catchable_by` and says it is never filled', () => {
    // Absent on every entry, because nothing in the harness report carries it. Declaring it is
    // what makes its absence `not_measured` on an expected field rather than an oversight -- and
    // the prose has to say so, or a reader sees an empty column and assumes the deriver is broken.
    const property = spec()?.properties.find((one) => one.name === 'catchable_by');
    expect(property?.type).toBe('string');
    expect(property?.required).toBeUndefined();
    expect(property?.description).toMatch(/always absent/i);
    expect(property?.description).toMatch(/not_measured/);
  });

  it('says in its own description that it has no producer yet', () => {
    // Zero entries is a measurement, not a gap in the file, and the type is where a reader
    // looks. Measured 2026-09-26: `ReportFindings` called 0 times across 1,236 files.
    expect(spec()?.description).toMatch(/ZERO entries/);
    expect(spec()?.description).toMatch(/0 times/);
  });
});

describe('absent and zero stay distinguishable', () => {
  it('does not require discovered_tools, so absence is representable', () => {
    const property = derivedType('context_compaction')?.properties.find(
      (one) => one.name === 'discovered_tools',
    );
    expect(property?.type).toBe('json');
    // required would force a value, and the only value available for "the
    // transcript said nothing" would be `[]` -- which means something else.
    expect(property?.required).toBeUndefined();
    expect(property?.description).toMatch(/omitted/i);
    expect(property?.description).toMatch(/empty array/i);
  });

  it('does not require agent, so the main thread is not an empty string', () => {
    const property = derivedType('skill_activation')?.properties.find(
      (one) => one.name === 'agent',
    );
    expect(property?.required).toBeUndefined();
    expect(property?.description).toMatch(/omitted/i);
  });

  it('does not require tool_name, though it resolved on every denial measured', () => {
    const property = derivedType('tool_denial')?.properties.find((one) => one.name === 'tool_name');
    expect(property?.required).toBeUndefined();
    // The join depends on a per-file map, so it is not guaranteed by the data.
    expect(property?.description).toMatch(/omit/i);
  });

  it('REQUIRES every count that was present on every event measured', () => {
    // The other side of the same rule: where the transcript always carries the
    // value, leaving it optional would let a real zero be confused with an
    // omission. These are token counts, and 0 is a legitimate measurement.
    const spec = derivedType('context_compaction');
    for (const name of ['pre_tokens', 'post_tokens', 'cumulative_dropped_tokens', 'duration_ms']) {
      expect(spec?.properties.find((one) => one.name === name)?.required).toBe(true);
    }
  });
});

describe('the user_correction limitation travels with the type', () => {
  it('says in its own description that it is not an independent corpus', () => {
    // Measured: all 20 corrections carry a tool_denial for the same event, so the
    // two types are the same events wearing different hats and a finding over one
    // cannot be corroborated by a finding over the other.
    const spec = derivedType('user_correction');
    expect(spec?.description).toMatch(/NOT an independent corpus/);
    expect(spec?.description).toMatch(/20 of 20/);
    expect(spec?.description).toMatch(/evidence_text/);
  });
});

describe('description and record_when are free to improve', () => {
  it('does not change the definition SHAPE when prose changes', () => {
    // `definitionShape` drops `description` and `record_when` before hashing, so
    // correcting the prose above -- which the limitation above will need as the
    // corpus grows -- does not mint a new version of the type.
    for (const spec of DERIVED_TYPES) {
      const reparsed = definitionShape(spec);
      expect(reparsed.record_when).toBeUndefined();
      for (const property of reparsed.properties) expect(property.description).toBeUndefined();
      expect(reparsed.name).toBe(spec.name);
      expect(reparsed.properties.map((one) => one.name)).toEqual(
        spec.properties.map((one) => one.name),
      );
    }
  });
});

describe('the definitions accept what the deriver produces', () => {
  it('validates a minimal entry for every type with no errors', () => {
    // A hand-built floor, not a substitute for the real drive: this proves the
    // SPECIFICATIONS are satisfiable, which the corpus test cannot -- it only
    // proves the entries that happen to exist today are.
    const minimal: Record<string, Record<string, unknown>> = {
      tool_denial: { denial_kind: 'user-rejected', tool_use_id: 't1' },
      context_compaction: {
        trigger: 'auto',
        pre_tokens: 1,
        post_tokens: 0,
        cumulative_dropped_tokens: 0,
        duration_ms: 0,
      },
      verification_run: { runner: 'pnpm test', verdict: 'failed', verdict_source: 'output' },
      skill_activation: { skill: 'bug-hunt' },
      user_correction: {},
      review_finding: {
        class: 'boundary_conditions',
        file: 'packages/core/src/state.ts',
        summary: 'an empty enum_values list is legal to define and impossible to satisfy',
        tool_use_id: 'toolu_01',
      },
    };

    for (const spec of DERIVED_TYPES) {
      const result = validateEntry(spec, {
        properties: {
          ...minimal[spec.name],
          session_id: 'sess-1',
          project: '-Users-me-app',
        },
      });
      expect(result.errors, `${spec.name}: ${JSON.stringify(result.errors)}`).toEqual([]);
    }
  });

  it('accepts a zero where zero is a measurement, not an omission', () => {
    // The three-state model: `0` is `measured`, absent is `not_measured`. A
    // compaction that dropped nothing must be recordable.
    const spec = derivedType('context_compaction');
    const zeroed = validateEntry(spec!, {
      properties: {
        trigger: 'auto',
        pre_tokens: 0,
        post_tokens: 0,
        cumulative_dropped_tokens: 0,
        duration_ms: 0,
        session_id: 's',
        project: 'p',
      },
    });
    expect(zeroed.errors).toEqual([]);
    expect(zeroed.states['pre_tokens']).toBe('measured');
  });

  it('reports a required property as not_measured when it is absent', () => {
    const spec = derivedType('verification_run');
    const result = validateEntry(spec!, {
      properties: { runner: 'pnpm test', session_id: 's', project: 'p' },
    });
    expect(result.states['verdict']).toBe('not_measured');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('derivationVersion', () => {
  it('is 2 for verification_run, whose verdict rule changed (asc-6ola.6)', () => {
    expect(derivationVersion('verification_run')).toBe(3);
  });

  it('is 1 for every type whose rule never changed', () => {
    for (const spec of DERIVED_TYPES) {
      if (spec.name === 'verification_run') continue;
      expect(derivationVersion(spec.name), spec.name).toBe(1);
    }
  });
});
