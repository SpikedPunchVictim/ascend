import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_PROPERTY_NAMES,
  canonicalizeTypeSpec,
  definitionShape,
  reservedPropertyName,
  validateEntry,
  type PropertySpec,
} from '@ascend/core';
import { DERIVED_SOURCE, DERIVED_TYPES, derivedType } from '../src/index.js';

/**
 * Invariants the five derived type definitions must hold, checked against core's own rules
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

describe('the five derived types', () => {
  it('ships exactly five, named for the events they are', () => {
    expect(DERIVED_TYPES.map((spec) => spec.name).sort()).toEqual([
      'context_compaction',
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
    // Roughly 90 tokens for all five, cheaper than the four starter types.
    const chars = DERIVED_TYPES.reduce((total, spec) => total + (spec.record_when?.length ?? 0), 0);
    expect(chars).toBeLessThan(400);
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
      verification_run: { runner: 'pnpm test', verdict: 'failed' },
      skill_activation: { skill: 'bug-hunt' },
      user_correction: {},
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
