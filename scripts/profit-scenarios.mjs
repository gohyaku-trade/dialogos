// Read-only scenario calculation. No API calls, secrets, or writes.
import { PACKAGES, MAX_COST_MICRO } from '../lib/api-v3.js';

const fx = Number(process.env.SCENARIO_JPY_PER_USD || 150);
if (!Number.isFinite(fx) || fx <= 0) throw new Error('SCENARIO_JPY_PER_USD must be positive');
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const feeRate = 0.036;
const plannedUsdPerReply = (3000 * 0.75 + 500 * 4.5) / 1e6;
const plannedYenPerReply = plannedUsdPerReply * fx;
const maxYenPerReply = MAX_COST_MICRO / 1e6 * fx;
const trialPeople = 1000;
const buyers = 50;
const trialYen = trialPeople * 3 * plannedYenPerReply;
const vercelYen = 20 * fx;
const supabaseYen = 25 * fx;

console.log(JSON.stringify({
  assumptions: { fx, feeRate, trialPeople, buyers, conversionRate: buyers / trialPeople, plannedUsdPerReply,
    allPurchasedRepliesConsumed: true, taxesSupportRefundsOveragesExcluded: true },
  perReply: { plannedYen: round(plannedYenPerReply), maximumYen: round(maxYenPerReply) },
  perFullTrial: { plannedYen: round(3 * plannedYenPerReply), maximumYen: round(3 * maxYenPerReply) },
  initialTrialBudgetCapacity: {
    plannedFullTrialsPerDay: Math.floor(0.5 / (3 * plannedUsdPerReply)),
    plannedFullTrialsPerMonth: Math.floor(5 / (3 * plannedUsdPerReply)),
    maximumCostFullTrialsPerDay: Math.floor(0.5 / (3 * MAX_COST_MICRO / 1e6)),
    maximumCostFullTrialsPerMonth: Math.floor(5 / (3 * MAX_COST_MICRO / 1e6)),
    warning: 'Budget equivalents, not guaranteed seats; reservations and failures can reduce capacity.'
  },
  packs: PACKAGES.map(pack => {
    if (!Number.isFinite(pack.price_jpy) || !Number.isFinite(pack.credits)) throw new Error('Invalid package pricing');
    const contribution = pack.price_jpy * (1 - feeRate) - pack.credits * plannedYenPerReply;
    return {
      yen: pack.price_jpy, replies: pack.credits,
      plannedContributionYen: round(contribution),
      maximumCostContributionYen: round(pack.price_jpy * (1 - feeRate) - pack.credits * maxYenPerReply),
      monthlyRevenueYen: pack.price_jpy * buyers,
      monthlyAfterTrialApiFeesVercelYen: round(buyers * contribution - trialYen - vercelYen),
      monthlyAlsoSupabaseProYen: round(buyers * contribution - trialYen - vercelYen - supabaseYen),
      breakEvenBuyersFor1000Trials: contribution > 0 ? Math.ceil((trialYen + vercelYen) / contribution) : null,
      breakEvenBuyersAlsoSupabasePro: contribution > 0 ? Math.ceil((trialYen + vercelYen + supabaseYen) / contribution) : null,
      requiredTotalApiBudgetUsd: round((trialPeople * 3 + buyers * pack.credits) * plannedUsdPerReply)
    };
  })
}, null, 2));
