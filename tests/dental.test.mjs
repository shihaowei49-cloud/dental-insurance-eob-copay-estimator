import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProcedure, estimateTreatmentPlan } from '../src/index.js';

const primary = Object.freeze({
  coveragePercent: Object.freeze({ preventive: 100, basic: 80, major: 50, ortho: 50 }),
  deductibleRemainingCents: 5_000,
  annualMaxRemainingCents: 25_000,
  orthoLifetimeMaxRemainingCents: 12_000,
  waivePreventiveDeductible: true,
});

function checkReconciliation(result) {
  for (const item of [...result.lines, result.totals]) {
    assert.equal(item.billedCents, item.writeOffCents + item.primaryPaidCents + item.secondaryPaidCents + item.patientCents);
    assert.equal(item.collectibleCents, item.billedCents - item.writeOffCents);
    assert.equal(item.collectibleCents, item.allowableCents + item.balanceBillCents);
    assert.ok(item.patientCents >= item.balanceBillCents);
  }
}

test('representative CDT tiers allow line-level, primary and secondary plan overrides', () => {
  assert.deepEqual(['d0120', 'D2391', 'D2740', 'D8080'].map((code) => classifyProcedure(code)),
    ['preventive', 'basic', 'major', 'ortho']);
  assert.throws(() => classifyProcedure('D3330'), /Enter a plan category for D3330/);
  assert.throws(() => classifyProcedure('<img src=x>'), /four digits/);
  assert.equal(classifyProcedure('d3330', { D3330: 'major' }), 'major');
  const result = estimateTreatmentPlan({
    procedures: [
      { code: 'D3330', billedCents: 100 },
      { code: 'D3330', category: 'basic', billedCents: 100 },
    ],
    primary: { categoryByCode: { D3330: 'major' }, coveragePercent: { major: 50, basic: 80 } },
    secondary: { categoryByCode: { D3330: 'basic' }, coveragePercent: { basic: 20 } },
  });
  assert.deepEqual(result.lines.map((line) => line.primary.paidCents), [50, 80]);
  assert.deepEqual(result.lines.map((line) => line.secondary.category), ['basic', 'basic']);
});

test('PPO write-offs, preventive waiver, annual cap and separate orthodontic cap reconcile', () => {
  const procedures = Object.freeze([
    Object.freeze({ code: 'D1110', billedCents: 10_000, contractedFeeCents: 8_500 }),
    Object.freeze({ code: 'D2740', billedCents: 120_001, contractedFeeCents: 80_001, ucrFeeCents: 70_000 }),
    Object.freeze({ code: 'D8090', billedCents: 100_000 }),
    Object.freeze({ code: 'D2391', billedCents: 8_000 }),
  ]);
  const result = estimateTreatmentPlan({ procedures, primary });
  const [cleaning, crown, ortho, filling] = result.lines;
  assert.equal(cleaning.primary.remaining.deductibleRemainingCents, 5_000);
  assert.equal(cleaning.primaryPaidCents, 8_500);
  assert.equal(crown.writeOffCents, 40_000);
  assert.equal(crown.primary.deductibleCents, 5_000);
  assert.equal(crown.primary.coinsuranceBenefitCents, 37_501);
  assert.equal(crown.primaryPaidCents, 16_500);
  assert.equal(crown.patientCents, 63_501);
  assert.equal(ortho.primaryPaidCents, 12_000);
  assert.equal(filling.primaryPaidCents, 0);
  assert.deepEqual(result.remaining.primary, {
    deductibleRemainingCents: 0, annualMaxRemainingCents: 0, orthoLifetimeMaxRemainingCents: 0,
  });
  assert.equal(primary.deductibleRemainingCents, 5_000);
  checkReconciliation(result);
});

test('deductible carries across eligible lines and preventive waiver is opt-in', () => {
  const result = estimateTreatmentPlan({
    procedures: [
      { code: 'D1110', billedCents: 2_000 },
      { code: 'D2740', billedCents: 15_000 },
      { code: 'D2392', billedCents: 25_000 },
    ],
    primary: { deductibleRemainingCents: 5_000, coveragePercent: { preventive: 100, basic: 80 } },
  });
  assert.deepEqual(result.lines.map((line) => line.primary.deductibleCents), [2_000, 0, 3_000]);
  assert.deepEqual(result.lines.map((line) => line.primary.paidCents), [0, 0, 17_600]);
  checkReconciliation(result);
});

test('UCR limits benefits while excess billed charges stay in the patient balance', () => {
  const procedures = [{ code: 'D2392', billedCents: 10_000, ucrFeeCents: 6_000, secondaryAllowedCents: 8_000 }];
  const plan = { coveragePercent: { basic: 100 } };
  const single = estimateTreatmentPlan({ procedures, primary: plan });
  const dual = estimateTreatmentPlan({ procedures, primary: plan, secondary: plan });
  assert.deepEqual([single.totals.balanceBillCents, single.totals.patientCents, single.totals.writeOffCents],
    [4_000, 4_000, 0]);
  assert.deepEqual([dual.totals.primaryPaidCents, dual.totals.secondaryPaidCents, dual.totals.patientCents],
    [6_000, 2_000, 2_000]);
  checkReconciliation(single);
  checkReconciliation(dual);
});

test('standard and non-duplication draw only actual payments from the secondary cap', () => {
  const input = {
    procedures: [{ code: 'D2740', billedCents: 10_001 }, { code: 'D2740', billedCents: 10_001 }],
    primary: { coveragePercent: { major: 50 } },
    secondary: { coveragePercent: { major: 80 }, annualMaxRemainingCents: 9_000 },
  };
  const standard = estimateTreatmentPlan(input);
  const nonDup = estimateTreatmentPlan({ ...input, cobMode: 'non-duplication' });
  assert.deepEqual(standard.lines.map((line) => line.secondaryPaidCents), [5_000, 4_000]);
  assert.deepEqual(nonDup.lines.map((line) => line.secondaryPaidCents), [3_000, 999]);
  assert.deepEqual(nonDup.lines.map((line) => line.secondary.remaining.annualMaxRemainingCents), [6_000, 5_001]);
  assert.deepEqual(nonDup.lines.map((line) => line.patientCents), [2_000, 4_001]);
  assert.equal(standard.remaining.secondary.annualMaxRemainingCents, 0);
  checkReconciliation(standard);
  checkReconciliation(nonDup);
});

test('secondary deductible and orthodontic max are independent of each primary accumulator', () => {
  const result = estimateTreatmentPlan({
    procedures: [
      { code: 'D8090', billedCents: 1_000 },
      { code: 'D2391', billedCents: 1_000 },
    ],
    primary: { coveragePercent: { ortho: 80, basic: 80 } },
    secondary: {
      coveragePercent: { ortho: 50, basic: 50 },
      deductibleRemainingCents: 200, orthoLifetimeMaxRemainingCents: 250, annualMaxRemainingCents: 100,
    },
  });
  assert.deepEqual(result.lines.map((line) => line.secondary.deductibleCents), [200, 0]);
  assert.deepEqual(result.lines.map((line) => line.secondaryPaidCents), [200, 100]);
  assert.deepEqual(result.remaining.secondary, {
    deductibleRemainingCents: 0, annualMaxRemainingCents: 0, orthoLifetimeMaxRemainingCents: 50,
  });
  checkReconciliation(result);
});

test('rounding is penny-exact for fractional percentages and safe integer limits', () => {
  const result = estimateTreatmentPlan({
    procedures: [{ code: 'D2392', billedCents: 3 }, { code: 'D2740', billedCents: 10_000 }],
    primary: { coveragePercent: { basic: 50, major: '33.33' } },
  });
  assert.deepEqual(result.lines.map((line) => line.primaryPaidCents), [2, 3_333]);
  const max = Number.MAX_SAFE_INTEGER;
  const large = estimateTreatmentPlan({
    procedures: [{ code: 'D2392', billedCents: max }],
    primary: { coveragePercent: { basic: 50 } },
  });
  assert.equal(large.totals.primaryPaidCents, 4_503_599_627_370_496);
  checkReconciliation(result);
  checkReconciliation(large);
});

test('leading-decimal coverage strings are interpreted as percentages', () => {
  const result = estimateTreatmentPlan({
    procedures: [{ code: 'D1110', billedCents: 10_000 }],
    primary: { coveragePercent: { preventive: '.5' } },
  });
  assert.equal(result.totals.primaryPaidCents, 50);
});

test('zero limits, zero fees and contractual approval below bill are handled explicitly', () => {
  const result = estimateTreatmentPlan({
    procedures: [{ code: 'D1110', billedCents: 800, contractedFeeCents: 0 }, { code: 'D8090', billedCents: 100 }],
    primary: { coveragePercent: { preventive: 100, ortho: 100 }, orthoLifetimeMaxRemainingCents: 0 },
  });
  assert.equal(result.totals.primaryPaidCents, 0);
  assert.equal(result.totals.writeOffCents, 800);
  assert.equal(result.totals.patientCents, 100);
  assert.equal(result.remaining.primary.annualMaxRemainingCents, null);
  checkReconciliation(result);
});

test('rejects amount and rate precision errors, unknown modes, and overflow', () => {
  const procedure = { code: 'D1110', billedCents: 100 };
  for (const amount of [-1, 1.2, Infinity, '100', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => estimateTreatmentPlan({ procedures: [{ ...procedure, billedCents: amount }], primary }), /cents/);
  }
  for (const rate of [-1, 100.01, '80.123', '.123', '.', '', 'eight', true, null]) {
    assert.throws(() => estimateTreatmentPlan({
      procedures: [procedure], primary: { coveragePercent: { preventive: rate } },
    }), /percentages/);
  }
  assert.throws(() => estimateTreatmentPlan({ procedures: [], primary, cobMode: 'other' }), /cobMode/);
  assert.throws(() => estimateTreatmentPlan({
    procedures: [procedure, { ...procedure, billedCents: Number.MAX_SAFE_INTEGER }], primary,
  }), /Total billedCents/);
});
