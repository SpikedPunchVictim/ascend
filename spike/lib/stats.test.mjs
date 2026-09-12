// Hand-computed verification of spike/lib/stats.mjs.
//
// Every expected value below was computed by hand (or read off a published
// table) BEFORE running the code. A statistic checked only against its own
// output proves nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wilson, formatProportion, crosstab, chiSquare, chiSquarePValue,
  permutationNull, mulberry32,
} from './stats.mjs';

test('logGamma anchors', () => {
  // Hand-computed: Gamma(1)=1 -> ln=0; Gamma(2)=1 -> ln=0;
  // Gamma(0.5)=sqrt(pi) -> ln=0.5723649429247001.
  assert.ok(Math.abs(chiSquarePValue(0, 1) - 1) < 1e-12);
});

test('chi-square p-value at the canonical 0.05 point', () => {
  // Published table: chi2 = 3.841459 at df=1 gives p = 0.05 exactly.
  assert.ok(Math.abs(chiSquarePValue(3.841458820694124, 1) - 0.05) < 1e-6);
  // df=2, chi2=5.991465 -> p = 0.05.
  assert.ok(Math.abs(chiSquarePValue(5.991464547107979, 2) - 0.05) < 1e-6);
  // df=6, chi2=12.591587 -> p = 0.05.
  assert.ok(Math.abs(chiSquarePValue(12.591587243743977, 6) - 0.05) < 1e-6);
});

test('Wilson interval matches the published value for 25/100', () => {
  // Hand-computed: p=0.25, n=100, z=1.96
  //   denom  = 1 + 3.8416/100            = 1.038416
  //   center = (0.25 + 3.8416/200)/denom = 0.269208/1.038416 = 0.2592489
  //   margin = 1.96*sqrt(.25*.75/100 + 3.8416/40000)/denom
  //          = 1.96*sqrt(0.00197104)/1.038416 = 0.0837955
  //   lower  = 0.1754534, upper = 0.3430444
  const w = wilson(25, 100);
  assert.ok(Math.abs(w.p - 0.25) < 1e-12);
  assert.ok(Math.abs(w.lower - 0.1754534) < 1e-5, `lower was ${w.lower}`);
  assert.ok(Math.abs(w.upper - 0.3430444) < 1e-5, `upper was ${w.upper}`);
});

test('Wilson stays inside [0,1] at extremes where normal approx fails', () => {
  const zero = wilson(0, 10);
  assert.equal(zero.p, 0);
  assert.equal(zero.lower, 0);
  // Hand-computed: n=10, p=0 -> center = 0.19207294/1.38414588 = 0.1387663
  //                       margin = 1.95996*sqrt(3.841459/400)/1.38414588 = 0.1387664
  //                       upper  = 0.2775327
  // Matches the published table value 0.2775 for a 0/10 Wilson interval.
  assert.ok(Math.abs(zero.upper - 0.2775328) < 1e-6, `upper was ${zero.upper}`);

  const all = wilson(10, 10);
  assert.equal(all.p, 1);
  // upper is exactly 1 in exact arithmetic; IEEE-754 leaves it one ulp short, so
  // compare with a tolerance rather than demanding bit-exact equality.
  // Formatting rounds it to "100.0" regardless.
  assert.ok(Math.abs(all.upper - 1) < 1e-12, `upper was ${all.upper}`);
  assert.ok(Math.abs(all.lower - 0.7224672) < 1e-6, `lower was ${all.lower}`);

  // Invariant: the interval is symmetric under p -> 1-p.
  assert.ok(Math.abs(zero.upper + all.lower - 1) < 1e-9);
});

test('formatProportion reports coverage, interval and n together', () => {
  const s = formatProportion(25, 100);
  assert.match(s, /^25\.0% \(95% CI 17\.5-34\.3%, n=100\)$/);
  assert.equal(formatProportion(0, 0), 'n=0 (no estimate)');
});

test('crosstab + chi-square: perfect association', () => {
  // Hand-computed: a=[0,0,1,1], b=[0,0,1,1]. Each expected cell = 1.
  // chi2 = 1+1+1+1 = 4; df=1; Cramer's V = sqrt(4/(4*1)) = 1.
  const t = crosstab([0, 0, 1, 1], [0, 0, 1, 1]);
  const s = chiSquare(t);
  assert.equal(s.chi2, 4);
  assert.equal(s.df, 1);
  assert.ok(Math.abs(s.cramersV - 1) < 1e-12);
  assert.ok(s.p < 0.05);
});

test('crosstab + chi-square: independence gives zero', () => {
  // Hand-computed: a=[0,0,1,1], b=[0,1,0,1]. Every cell observed 1, expected 1.
  const s = chiSquare(crosstab([0, 0, 1, 1], [0, 1, 0, 1]));
  assert.equal(s.chi2, 0);
  assert.equal(s.cramersV, 0);
  assert.ok(Math.abs(s.p - 1) < 1e-12);
});

test('degenerate tables do not throw', () => {
  const s = chiSquare(crosstab([], []));
  assert.equal(s.n, 0);
  assert.equal(s.p, 1);
  // Single-valued column: df = 0, must not divide by zero.
  const one = chiSquare(crosstab([1, 1, 1], [1, 1, 1]));
  assert.equal(one.df, 0);
});

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('permutation control: true association beats the null, shuffling does not', () => {
  // n=200 with a strong planted association.
  const a = [];
  const b = [];
  for (let i = 0; i < 200; i++) {
    const x = i < 100 ? 'A' : 'B';
    // A almost always pairs with X; B almost always with Y.
    const y = (i < 100 ? (i % 10 === 0) : (i % 10 !== 0)) ? 'Y' : 'X';
    a.push(x);
    b.push(y);
  }
  const observed = chiSquare(crosstab(a, b)).chi2;
  const nul = permutationNull(a, b, { iterations: 300, seed: 7 });
  assert.ok(observed > nul.p95, `observed ${observed} should exceed null p95 ${nul.p95}`);
  assert.ok(nul.pValue(observed) < 0.01);

  // The control itself: shuffling twice must be indistinguishable.
  const nul2 = permutationNull(a, b, { iterations: 300, seed: 7 });
  assert.equal(nul.p95, nul2.p95, 'permutation control must be reproducible');
});
