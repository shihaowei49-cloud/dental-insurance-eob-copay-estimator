# Dental Insurance EOB & Copay Estimator

A zero-dependency ES module for estimating dental treatment costs. It reconciles each billed fee to the contractual write-off and the amounts paid by the patient and each insurer. [Interactive GitHub Pages demo](https://shihaowei49-cloud.github.io/dental-insurance-eob-copay-estimator/)

## Use the module

Use Node.js 20 or later, or import the module in a modern browser. From this checkout, import `./src/index.js`.

```js
import { estimateTreatmentPlan } from './src/index.js';

const estimate = estimateTreatmentPlan({
  procedures: [
    { code: 'D1110', billedCents: 10_000, contractedFeeCents: 8_500 },
    { code: 'D2740', billedCents: 120_001, contractedFeeCents: 80_001 },
  ],
  primary: {
    coveragePercent: { preventive: 100, basic: 80, major: 50, ortho: 50 },
    deductibleRemainingCents: 5_000,
    waivePreventiveDeductible: true,
    annualMaxRemainingCents: 25_000,
    orthoLifetimeMaxRemainingCents: 120_000,
  },
});
console.log(estimate.totals.patientCents); // 63501
console.log(estimate.remaining.primary.annualMaxRemainingCents); // 0
```

## Inputs and plan rules

Pass `{ procedures, primary, secondary?, cobMode? }` to `estimateTreatmentPlan`.

- Each ordered procedure has a `code` and `billedCents`, with optional `category`, `contractedFeeCents`, `ucrFeeCents`, and `secondaryAllowedCents`. Use whole, nonnegative safe integer cents for fees. Process lines in the expected claim order.
- `classifyProcedure(code, categoryByCode?)` maps representative CDT codes to the frozen `PROCEDURE_CATEGORIES` tiers `preventive`, `basic`, `major`, and `ortho`. D1110, D2391, D2740, and D8090 are examples. Each plan may supply its own `categoryByCode` keyed by uppercase code. For the primary plan, the line's explicit category takes precedence over that plan's map, followed by the built-in example mapping. The secondary plan uses its own override where supplied and inherits the primary line's category otherwise. Supply an explicit tier or plan mapping for codes outside the example set.
- The plan's `coveragePercent` object gives the **insurer-paid** percentage by tier, from 0 through 100 with up to two decimal places. Numbers and decimal strings are accepted. Omitted tiers pay 0%.
- `deductibleRemainingCents` defaults to zero. Each line with positive coverage reduces that plan's deductible by the eligible amount up to the remaining balance, unless the line is preventive and `waivePreventiveDeductible` is `true`. The waiver defaults to `false`. Deductible accounting occurs before coinsurance, caps, and COB.
- `annualMaxRemainingCents` applies to preventive, basic, and major care. `orthoLifetimeMaxRemainingCents` applies to ortho care instead. Omit either cap or set it to `null` for an uncapped estimate. Passing 0 sets an exhausted cap. Each cap is reduced by the insurer's actual payment.
- A PPO contract caps the collectible fee at the smaller of the billed and contracted fees. Their difference is the write-off. For a line without a PPO amount, the collectible fee is the bill and `ucrFeeCents` can lower the primary benefit basis. A supplied UCR amount is used only on lines without a contract amount.
- The secondary plan defaults to the primary allowed amount as its coverage basis. Use `secondaryAllowedCents` when the carrier uses a different basis. The combined allowable expense is the larger plan allowance, bounded by the collectible fee. The remaining collectible charge above the combined allowance is a patient balance bill.

## Payment order

1. Apply each plan's deductible, calculate coinsurance using integer arithmetic with half-up rounding to cents, and apply the corresponding benefit cap.
2. For `cobMode: 'standard'` (default), allow the secondary plan's standalone benefit up to the unpaid combined allowable expense. For `'non-duplication'`, subtract the primary payment from the secondary standalone benefit, floor at zero, and apply the same unpaid-expense limit.
3. Charge the remaining collectible cents to the patient. Each line and the totals satisfy `billedCents = writeOffCents + primaryPaidCents + secondaryPaidCents + patientCents`.

The result contains `lines`, `totals`, and `remaining` balances for each plan. Each line includes a per-plan ledger with allowed fee, deductible, rounded coinsurance benefit, capped standalone benefit, actual paid amount, and remaining balances after that line. The secondary ledger is `null` with single coverage.

Use carrier documents to confirm actual CDT tiers, exclusions, deductible credit rules, benefit accumulators, and COB terms. This estimate implements the stated plan inputs and two defined COB formulas.

## Development

Run `node --test` from this checkout. To preview the static demo, serve the `docs/` directory on localhost with an HTTP static server and open the server's URL in a browser. For GitHub Pages, select the repository branch and `/docs` as the source. The demo imports its adjacent byte-identical module and keeps calculations in the page.

[MIT license](./LICENSE)

## Related Full Workbenches

- [DentalPlan](https://dentalplan.shihaoeth.site/?utm_source=github_oss&utm_medium=repo_pages&utm_campaign=quality_wave_8)
- [BoatHaul](https://boathaul.shihaoeth.site/?utm_source=github_oss&utm_medium=repo_pages&utm_campaign=quality_wave_8)
