/*
MIT License

Copyright (c) 2026 shihaowei49-cloud contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

export const PROCEDURE_CATEGORIES = Object.freeze(['preventive', 'basic', 'major', 'ortho']);

const exampleCategories = Object.freeze({
  D0120: 'preventive',
  D0150: 'preventive',
  D0274: 'preventive',
  D1110: 'preventive',
  D1120: 'preventive',
  D1206: 'preventive',
  D1351: 'preventive',
  D2140: 'basic',
  D2391: 'basic',
  D2392: 'basic',
  D2740: 'major',
  D2750: 'major',
  D2950: 'major',
  D8080: 'ortho',
  D8090: 'ortho',
});

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function procedureCode(code) {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!/^D\d{4}$/.test(normalized)) throw new RangeError('Procedure code must be D followed by four digits.');
  return normalized;
}

function checkCategory(category) {
  if (!PROCEDURE_CATEGORIES.includes(category)) {
    throw new RangeError('Category must be preventive, basic, major, or ortho.');
  }
  return category;
}

function categoryFor(code, overrides) {
  const category = Object.hasOwn(overrides, code) ? overrides[code] : exampleCategories[code];
  if (category === undefined) throw new RangeError(`Enter a plan category for ${code}.`);
  return checkCategory(category);
}

export function classifyProcedure(code, categoryByCode = {}) {
  return categoryFor(procedureCode(code), record(categoryByCode, 'categoryByCode'));
}

function cents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer in cents.`);
  }
  return value;
}

function optionalCents(value, label) {
  return value == null ? null : cents(value, label);
}

function rateInBasisPoints(value) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.startsWith('.') ? `0${text}` : text);
  const rate = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : NaN;
  if (!(rate <= 10_000)) throw new RangeError('Coverage percentages must be 0 to 100 with up to two decimal places.');
  return rate;
}

function makePlan(plan, label) {
  record(plan, label);
  const percentages = record(plan.coveragePercent ?? {}, `${label} coveragePercent`);
  for (const category of Object.keys(percentages)) checkCategory(category);
  const waivePreventiveDeductible = plan.waivePreventiveDeductible ?? false;
  if (typeof waivePreventiveDeductible !== 'boolean') {
    throw new TypeError(`${label} waivePreventiveDeductible must be a boolean.`);
  }
  return {
    rates: Object.fromEntries(PROCEDURE_CATEGORIES.map((category) => [
      category, rateInBasisPoints(Object.hasOwn(percentages, category) ? percentages[category] : 0),
    ])),
    categoryByCode: record(plan.categoryByCode ?? {}, `${label} categoryByCode`),
    waivePreventiveDeductible,
    balances: {
      deductibleRemainingCents: cents(plan.deductibleRemainingCents ?? 0, `${label} deductibleRemainingCents`),
      annualMaxRemainingCents: optionalCents(plan.annualMaxRemainingCents, `${label} annualMaxRemainingCents`),
      orthoLifetimeMaxRemainingCents: optionalCents(plan.orthoLifetimeMaxRemainingCents, `${label} orthoLifetimeMaxRemainingCents`),
    },
  };
}

function standAloneBenefit(plan, category, allowedCents) {
  const { rates, balances, waivePreventiveDeductible } = plan;
  const rate = rates[category];
  const deductibleApplies = rate > 0 && !(category === 'preventive' && waivePreventiveDeductible);
  const deductibleCents = deductibleApplies ? Math.min(allowedCents, balances.deductibleRemainingCents) : 0;
  balances.deductibleRemainingCents -= deductibleCents;

  // Round half up in cents before applying the remaining benefit cap.
  const coinsuranceBenefitCents = Number((BigInt(allowedCents - deductibleCents) * BigInt(rate) + 5000n) / 10000n);
  const maximum = category === 'ortho' ? 'orthoLifetimeMaxRemainingCents' : 'annualMaxRemainingCents';
  const capRemainingCents = balances[maximum];
  const benefitCents = Math.min(coinsuranceBenefitCents, capRemainingCents ?? coinsuranceBenefitCents);
  return { deductibleCents, coinsuranceBenefitCents, benefitCents, maximum };
}

function recordPayment(plan, category, allowedCents, benefit, paidCents) {
  const { deductibleCents, coinsuranceBenefitCents, benefitCents, maximum } = benefit;
  const capBefore = plan.balances[maximum];
  if (capBefore !== null) plan.balances[maximum] -= paidCents;
  return {
    category,
    allowedCents,
    deductibleCents,
    coinsuranceBenefitCents,
    cappedBenefitCents: benefitCents,
    paidCents,
    remaining: { ...plan.balances },
  };
}

function adjudicate(line, primary, secondary, cobMode) {
  record(line, 'Procedure');
  const code = procedureCode(line.code);
  const category = line.category == null ? categoryFor(code, primary.categoryByCode) : checkCategory(line.category);
  const billedCents = cents(line.billedCents, 'billedCents');
  const contracted = optionalCents(line.contractedFeeCents, 'contractedFeeCents');
  const ucr = optionalCents(line.ucrFeeCents, 'ucrFeeCents');
  const secondaryAllowed = optionalCents(line.secondaryAllowedCents, 'secondaryAllowedCents');
  const collectibleCents = Math.min(billedCents, contracted ?? billedCents);
  const primaryAllowed = contracted == null && ucr != null ? Math.min(collectibleCents, ucr) : collectibleCents;
  const primaryBenefit = standAloneBenefit(primary, category, primaryAllowed);
  const primaryPaidCents = primaryBenefit.benefitCents;
  const primaryLine = recordPayment(primary, category, primaryAllowed, primaryBenefit, primaryPaidCents);

  let allowableCents = primaryAllowed;
  let secondaryPaidCents = 0;
  let secondaryLine = null;
  if (secondary) {
    const secondaryCategory = Object.hasOwn(secondary.categoryByCode, code)
      ? categoryFor(code, secondary.categoryByCode)
      : category;
    const secondaryBasis = Math.min(collectibleCents, secondaryAllowed ?? primaryAllowed);
    allowableCents = Math.max(primaryAllowed, secondaryBasis);
    const benefit = standAloneBenefit(secondary, secondaryCategory, secondaryBasis);
    const cobBenefit = cobMode === 'non-duplication'
      ? Math.max(0, benefit.benefitCents - primaryPaidCents)
      : benefit.benefitCents;
    secondaryPaidCents = Math.min(cobBenefit, allowableCents - primaryPaidCents);
    secondaryLine = recordPayment(secondary, secondaryCategory, secondaryBasis, benefit, secondaryPaidCents);
  }

  return {
    code, category, billedCents, collectibleCents, allowableCents,
    writeOffCents: billedCents - collectibleCents,
    balanceBillCents: collectibleCents - allowableCents,
    primaryPaidCents, secondaryPaidCents,
    patientCents: collectibleCents - primaryPaidCents - secondaryPaidCents,
    primary: primaryLine,
    secondary: secondaryLine,
  };
}

export function estimateTreatmentPlan({ procedures, primary, secondary = null, cobMode = 'standard' } = {}) {
  if (!Array.isArray(procedures)) throw new TypeError('procedures must be an array.');
  if (cobMode !== 'standard' && cobMode !== 'non-duplication') {
    throw new RangeError('cobMode must be standard or non-duplication.');
  }
  const primaryPlan = makePlan(primary, 'Primary plan');
  const secondaryPlan = secondary == null ? null : makePlan(secondary, 'Secondary plan');
  const totals = {
    billedCents: 0, collectibleCents: 0, allowableCents: 0, writeOffCents: 0,
    balanceBillCents: 0, primaryPaidCents: 0, secondaryPaidCents: 0, patientCents: 0,
  };
  const fields = Object.keys(totals);
  const lines = Array.from(procedures, (procedure) => {
    const line = adjudicate(procedure, primaryPlan, secondaryPlan, cobMode);
    for (const key of fields) totals[key] = cents(totals[key] + line[key], `Total ${key}`);
    return line;
  });
  return {
    lines,
    totals,
    remaining: {
      primary: { ...primaryPlan.balances },
      secondary: secondaryPlan ? { ...secondaryPlan.balances } : null,
    },
  };
}
