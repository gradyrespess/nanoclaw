/**
 * Cost Tracker
 *
 * Estimates and logs API costs per tier. All token counts are rough estimates
 * (~1 token per 4 characters) since the container SDK doesn't expose exact counts.
 * Use for relative tracking and spend awareness, not billing reconciliation.
 */
import { getTierUsageSince, logTierUsage as dbLogTierUsage } from './db.js';
import { TIER_COSTS, TIER_MODELS, Tier } from './tier-router.js';

export interface TierUsageEntry {
  tier: Tier;
  model: string | null;
  groupFolder: string;
  isCacheHit: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  promptPreview: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateCostUsd(
  tier: 2 | 3 | 4,
  inputTokens: number,
  outputTokens: number,
): number {
  const costs = TIER_COSTS[tier];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

export function logTierUsage(entry: TierUsageEntry): void {
  const costUsd =
    entry.tier >= 2 && !entry.isCacheHit
      ? estimateCostUsd(
          entry.tier as 2 | 3 | 4,
          entry.estimatedInputTokens,
          entry.estimatedOutputTokens,
        )
      : 0;

  dbLogTierUsage({
    timestamp: new Date().toISOString(),
    group_folder: entry.groupFolder,
    tier: entry.tier,
    model: entry.model,
    is_cache_hit: entry.isCacheHit ? 1 : 0,
    estimated_input_tokens: entry.estimatedInputTokens,
    estimated_output_tokens: entry.estimatedOutputTokens,
    estimated_cost_usd: costUsd,
    prompt_preview: entry.promptPreview.slice(0, 120),
  });
}

export function getWeeklyCostReport(): string {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getTierUsageSince(since);

  const byTier: Record<
    number,
    { count: number; cost: number; cacheHits: number }
  > = {
    1: { count: 0, cost: 0, cacheHits: 0 },
    2: { count: 0, cost: 0, cacheHits: 0 },
    3: { count: 0, cost: 0, cacheHits: 0 },
    4: { count: 0, cost: 0, cacheHits: 0 },
  };

  const byGroup: Record<string, { count: number; cost: number }> = {};
  let totalCost = 0;
  let totalCacheHits = 0;
  let cacheSavings = 0;

  // Baseline cost = what all API calls would cost at Sonnet 3 pricing
  let baselineCost = 0;

  for (const row of rows) {
    const tier = row.tier as Tier;
    if (!byTier[tier]) continue;

    if (row.is_cache_hit) {
      totalCacheHits++;
      byTier[tier].cacheHits++;
      // Estimate what this cache hit saved
      if (tier >= 2) {
        cacheSavings += estimateCostUsd(
          tier as 2 | 3 | 4,
          row.estimated_input_tokens,
          // Assume output would have been ~same as input for estimate
          row.estimated_input_tokens,
        );
      }
      continue;
    }

    byTier[tier].count++;
    byTier[tier].cost += row.estimated_cost_usd;
    totalCost += row.estimated_cost_usd;

    // Compute Sonnet baseline for this row
    if (tier >= 2) {
      baselineCost += estimateCostUsd(
        3,
        row.estimated_input_tokens,
        row.estimated_output_tokens,
      );
    }

    const group = row.group_folder;
    if (!byGroup[group]) byGroup[group] = { count: 0, cost: 0 };
    byGroup[group].count++;
    byGroup[group].cost += row.estimated_cost_usd;
  }

  const savings = baselineCost - totalCost;
  const savingsPct =
    baselineCost > 0 ? Math.round((savings / baselineCost) * 100) : 0;

  const tierLabels: Record<number, string> = {
    1: 'Tier 1 (Instant)',
    2: 'Tier 2 (Haiku)  ',
    3: 'Tier 3 (Sonnet) ',
    4: 'Tier 4 (Opus)   ',
  };

  const modelLabels: Record<number, string> = {
    1: 'no API',
    2: TIER_MODELS[2],
    3: TIER_MODELS[3],
    4: TIER_MODELS[4],
  };

  const lines: string[] = ['**Cost Report — Last 7 Days**\n'];

  for (const [t, label] of Object.entries(tierLabels)) {
    const tier = Number(t);
    const data = byTier[tier];
    const cost = data.cost > 0 ? `~$${data.cost.toFixed(4)}` : '$0.00';
    const hits = data.cacheHits > 0 ? ` (${data.cacheHits} cached)` : '';
    lines.push(
      `${label}  ${String(data.count).padStart(4)} requests   ${cost}${hits}`,
    );
  }

  lines.push('');
  lines.push(`Total API cost: ~$${totalCost.toFixed(4)}`);

  if (totalCacheHits > 0) {
    lines.push(
      `Cache hits: ${totalCacheHits}  (saved ~$${cacheSavings.toFixed(4)})`,
    );
  }

  if (baselineCost > 0 && savings > 0) {
    lines.push(
      `\nvs. all-Sonnet baseline: ~$${baselineCost.toFixed(4)} → savings ~$${savings.toFixed(4)} (${savingsPct}%)`,
    );
  }

  const topGroups = Object.entries(byGroup)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .slice(0, 5);

  if (topGroups.length > 0) {
    lines.push('\nTop groups by spend:');
    for (const [group, data] of topGroups) {
      lines.push(`  ${group}: ${data.count} req, ~$${data.cost.toFixed(4)}`);
    }
  }

  lines.push(
    `\n_Model mapping: ${Object.entries(modelLabels)
      .map(([t, m]) => `T${t}=${m}`)
      .join(', ')}_`,
  );

  return lines.join('\n');
}
