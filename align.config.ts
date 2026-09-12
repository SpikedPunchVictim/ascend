import { defineProject, external } from '@spikedpunch/align-core/dsl';

/**
 * ascend's architecture-conformance ruleset.
 *
 * These are the machine-checked form of the prose invariants in ARCHITECTURE.md and TASKS.md.
 * The hand-written ESLint block in `eslint.config.js` and
 * `packages/core/test/purity-enforcement.test.ts` enforce the same contract at edit time; this is
 * the enforcement of record at check time. If the two ever disagree, one of them is wrong --
 * resolve it, don't paper over it.
 *
 * Seeded at a ZERO baseline: this is greenfield, there is no legacy debt to tolerate. A non-zero
 * baseline here means something is wrong, not that something is tolerated.
 *
 * Authorable verbs are pinned by `describeDslVerbs()`: `.cannotDependOn` and `.canOnlyDependOn`
 * live on `arch.layer(x)`, NOT on the bare `c.<component>` token.
 */
export default defineProject({
  components: {
    // Declared FIRST, and that ordering is load-bearing: component classification is
    // first-match-wins, so without this every test file would be classified into its package
    // (e.g. `packages/core/test/**` -> `core`) and inherit the purity rules. Tests are not pure
    // code -- they spawn processes, read the repo, and include deliberate-violation fixtures --
    // so applying `no node:*` to them would be wrong, and the "fix" would be to weaken the rule.
    tests: 'packages/*/test/**',

    adapterClaudeCode: 'packages/adapter-claude-code/**',
    analysis: 'packages/analysis/**',
    cli: 'packages/cli/**',
    core: 'packages/core/**',
    store: 'packages/store/**',
  },

  rules: (c) => [
    // Latent bugs surface here before anywhere else, on healthy repos included.
    c.arch.noCycles(),

    // ---- Purity: core and analysis import ZERO Node builtins ------------------
    //
    // `node:*` is deliberately broader than the three named in TASKS.md (fs, node:sqlite,
    // network). A pure package should import no builtin at all: a filesystem read, a clock and a
    // socket are the same category of mistake, and a denylist of three would silently admit the
    // fourth. Statistics and spec logic stay testable against plain fixtures because of this.
    c.arch
      .layer(c.core)
      .cannotDependOn(external('node:*'))
      .because('core is pure: no fs, no sqlite, no network, no ambient environment.'),
    c.arch
      .layer(c.analysis)
      .cannotDependOn(external('node:*'))
      .because('analysis is pure: pure functions over plain arrays, so every method is testable.'),

    // ---- Layering: core never imports store or adapter ------------------------
    c.arch
      .layer(c.core)
      .cannotDependOn(c.store, c.adapterClaudeCode)
      .because('core never imports store or adapter types (ARCHITECTURE.md, Packages).'),
    c.arch
      .layer(c.analysis)
      .cannotDependOn(c.store, c.adapterClaudeCode)
      .because('analysis is pure functions over plain arrays; no database involved.'),

    // ---- store is the ONLY component that touches SQLite ----------------------
    c.arch
      .layer(c.analysis)
      .cannotDependOn(external('node:sqlite'))
      .because('only @ascend/store may touch SQLite.'),
    c.arch
      .layer(c.adapterClaudeCode)
      .cannotDependOn(external('node:sqlite'))
      .because('only @ascend/store may touch SQLite; the adapter derives entries, it stores none.'),
    c.arch
      .layer(c.cli)
      .cannotDependOn(external('node:sqlite'))
      .because('only @ascend/store may touch SQLite; the CLI goes through the store package.'),

    // ---- cli is imported by nothing -------------------------------------------
    //
    // Expressed as "every other component cannot depend on cli" rather than isIsolated(),
    // because cli legitimately depends on the other four -- isolation is the wrong shape.
    c.arch.layer(c.core).cannotDependOn(c.cli).because('cli is the only interface in v1.'),
    c.arch.layer(c.analysis).cannotDependOn(c.cli).because('cli is the only interface in v1.'),
    c.arch.layer(c.store).cannotDependOn(c.cli).because('cli is the only interface in v1.'),
    c.arch
      .layer(c.adapterClaudeCode)
      .cannotDependOn(c.cli)
      .because('cli is the only interface in v1.'),

    // ---- Dependency hygiene ---------------------------------------------------
    c.security.manifest.sourceHygiene(),
    c.security.manifest.newDependencyGate(),
  ],
});
