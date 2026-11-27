import { estimateTreatmentPlan, PROCEDURE_CATEGORIES } from './lib.js';

const form = document.querySelector('#estimate-form');
const plans = document.querySelector('#plans');
const procedures = document.querySelector('#procedures');
const planTemplate = document.querySelector('#plan-template');
const procedureTemplate = document.querySelector('#procedure-template');
const addButton = document.querySelector('#add');
const dual = document.querySelector('#dual');
const cob = document.querySelector('#cob-mode');
const error = document.querySelector('#form-error');
const patientTotal = document.querySelector('#patient-total');
const paymentTotals = document.querySelector('#payment-totals');
const lines = document.querySelector('#lines');
const remaining = document.querySelector('#remaining');
const dollarFormatter = new Intl.NumberFormat('en-US');

function element(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function dollars(value) {
  if (value === null) return 'Uncapped';
  const amount = BigInt(value);
  return `$${dollarFormatter.format(amount / 100n)}.${String(amount % 100n).padStart(2, '0')}`;
}

function field(group, name) {
  return group.querySelector(`[name="${name}"]`);
}

function money(group, name, label) {
  const raw = field(group, name).value.trim();
  if (!raw) return null;
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(raw.startsWith('.') ? `0${raw}` : raw);
  if (!match) throw new RangeError(`${label} must be a dollar amount with up to two decimal places.`);
  const amount = Number(BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')));
  if (!Number.isSafeInteger(amount)) throw new RangeError(`${label} is too large.`);
  return amount;
}

function definitionList(list, entries) {
  list.replaceChildren();
  for (const [term, description] of entries) {
    const group = document.createElement('div');
    group.append(element('dt', term), element('dd', description));
    list.append(group);
  }
}

function fillFields(group, values) {
  for (const [name, value] of Object.entries(values)) field(group, name).value = value;
}

function addPlan(title, defaults) {
  const plan = planTemplate.content.firstElementChild.cloneNode(true);
  plan.querySelector('legend').textContent = title;
  fillFields(plan, defaults);
  field(plan, 'waiver').checked = true;
  plans.append(plan);
  return plan;
}

function addProcedure(defaults = {}, focus = true) {
  const row = procedureTemplate.content.firstElementChild.cloneNode(true);
  fillFields(row, defaults);
  field(row, 'secondaryAllowed').disabled = !dual.checked;
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    addButton.focus();
    if (form.checkValidity()) calculate();
  });
  procedures.append(row);
  if (focus) field(row, 'code').focus();
}

function readPlan(plan) {
  return {
    coveragePercent: Object.fromEntries(PROCEDURE_CATEGORIES.map((tier) => [tier, field(plan, tier).value])),
    deductibleRemainingCents: money(plan, 'deductible', 'Deductible'),
    annualMaxRemainingCents: money(plan, 'annual', 'Annual maximum'),
    orthoLifetimeMaxRemainingCents: money(plan, 'orthoMax', 'Ortho lifetime maximum'),
    waivePreventiveDeductible: field(plan, 'waiver').checked,
  };
}

function readProcedure(row) {
  return {
    code: field(row, 'code').value,
    category: field(row, 'category').value || undefined,
    billedCents: money(row, 'billed', 'Billed fee'),
    contractedFeeCents: money(row, 'ppo', 'PPO fee'),
    ucrFeeCents: money(row, 'ucr', 'UCR amount'),
    secondaryAllowedCents: dual.checked ? money(row, 'secondaryAllowed', 'Secondary allowed fee') : null,
  };
}

function renderRemaining(title, balances) {
  if (!balances) return;
  const section = document.createElement('section');
  const list = document.createElement('dl');
  definitionList(list, [
    ['Deductible left', dollars(balances.deductibleRemainingCents)],
    ['Annual maximum left', dollars(balances.annualMaxRemainingCents)],
    ['Ortho lifetime maximum left', dollars(balances.orthoLifetimeMaxRemainingCents)],
  ]);
  section.append(element('h3', title), list);
  remaining.append(section);
}

function renderResult(result) {
  const { totals } = result;
  patientTotal.textContent = dollars(totals.patientCents);
  definitionList(paymentTotals, [
    ['Billed', dollars(totals.billedCents)],
    ['PPO write-off', dollars(totals.writeOffCents)],
    ['Primary pays', dollars(totals.primaryPaidCents)],
    ['Secondary pays', dollars(totals.secondaryPaidCents)],
  ]);

  lines.replaceChildren();
  for (const line of result.lines) {
    const row = document.createElement('tr');
    const heading = element('th', line.code);
    heading.scope = 'row';
    row.append(heading, element('td', line.category));
    for (const key of ['billedCents', 'writeOffCents', 'balanceBillCents', 'primaryPaidCents', 'secondaryPaidCents', 'patientCents']) {
      row.append(element('td', dollars(line[key])));
    }
    lines.append(row);
  }
  if (result.lines.length === 0) {
    const row = document.createElement('tr');
    const cell = element('td', 'Add a procedure to see a line estimate.');
    cell.colSpan = 8;
    row.append(cell);
    lines.append(row);
  }
  remaining.replaceChildren();
  renderRemaining('Primary balances', result.remaining.primary);
  renderRemaining('Secondary balances', result.remaining.secondary);
}

function calculate() {
  try {
    renderResult(estimateTreatmentPlan({
      procedures: Array.from(procedures.children, readProcedure),
      primary: readPlan(primaryPlan),
      secondary: dual.checked ? readPlan(secondaryPlan) : null,
      cobMode: cob.value,
    }));
    error.hidden = true;
  } catch (problem) {
    patientTotal.textContent = 'Estimate unavailable';
    paymentTotals.replaceChildren();
    lines.replaceChildren();
    remaining.replaceChildren();
    error.textContent = problem.message;
    error.hidden = false;
  }
}

const primaryPlan = addPlan('Primary plan', {
  preventive: '100', basic: '80', major: '50', ortho: '50',
  deductible: '50.00', annual: '250.00', orthoMax: '120.00',
});
const secondaryPlan = addPlan('Secondary plan', {
  preventive: '100', basic: '60', major: '35', ortho: '25',
  deductible: '25.00', annual: '200.00', orthoMax: '80.00',
});
addProcedure({ code: 'D1110', billed: '100.00', ppo: '85.00' }, false);
addProcedure({ code: 'D2740', billed: '1200.01', ppo: '800.01' }, false);
addProcedure({ code: 'D8090', billed: '1080.00', ucr: '1000.00' }, false);

dual.addEventListener('change', () => {
  secondaryPlan.disabled = !dual.checked;
  cob.disabled = !dual.checked;
  for (const row of procedures.children) field(row, 'secondaryAllowed').disabled = !dual.checked;
});
addButton.addEventListener('click', () => addProcedure());
form.addEventListener('submit', (event) => {
  event.preventDefault();
  calculate();
});
calculate();
