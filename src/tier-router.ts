/**
 * Tiered Intelligence Router
 *
 * Classifies each request into a tier to minimize API costs:
 *   Tier 1 — Instant (no API): greetings, acks, cached responses
 *   Tier 2 — Haiku (default, cheap): simple lookups, scheduled tasks, factual Q&A
 *   Tier 3 — Sonnet (smarter): multi-step tasks, document analysis, judgment required
 *   Tier 4 — Opus (explicit only): "use your best thinking" / "this is important"
 */
import crypto from 'crypto';

import { NewMessage } from './types.js';

export type Tier = 1 | 2 | 3 | 4;

export const TIER_MODELS: Record<2 | 3 | 4, string> = {
  2: 'claude-haiku-4-5-20251001',
  3: 'claude-sonnet-4-6',
  4: 'claude-opus-4-6',
};

// Approximate cost per 1M tokens (USD) — used for estimation only
export const TIER_COSTS: Record<2 | 3 | 4, { input: number; output: number }> =
  {
    2: { input: 0.8, output: 4.0 },
    3: { input: 3.0, output: 15.0 },
    4: { input: 15.0, output: 75.0 },
  };

export interface TierDecision {
  tier: Tier;
  model: string | null; // null for Tier 1 (no API call)
  instantResponse?: string; // Tier 1 only
  reason: string;
  cacheable: boolean; // Whether response should be cached after API call
  cacheKey: string; // Always set — used for both read and write
}

// Standalone greetings — whole message (after trigger stripped) must match exactly
const GREETING_PATTERNS = [
  /^(hi|hello|hey|howdy|sup|yo|gm|gn)$/i,
  /^good\s+(morning|afternoon|evening|night)$/i,
  /^what'?s\s+up\??$/i,
  /^greetings$/i,
];

// Standalone acknowledgments — whole message (after trigger stripped) must match exactly
const ACK_PATTERNS = [
  /^(ok|okay|k|alright|sure|yep|yeah|yup|nope|nah|yes|no)$/i,
  /^(got\s+it|noted|understood|sounds\s+good|perfect|great|cool|nice)$/i,
  /^(thanks?|thank\s+you|thx|ty|cheers|appreciate\s+(it|that))$/i,
  /^(np|no\s+problem|no\s+worries|all\s+good)$/i,
];

// Tier 4 triggers — user explicitly requests deepest reasoning
const OPUS_TRIGGERS = [
  /\buse (your )?best (thinking|analysis|judgment)\b/i,
  /\bthis is (very |extremely |critically )?(important|critical)\b/i,
  /\bthink (very )?carefully\b/i,
  /\b(deep|critical|thorough|comprehensive) analysis\b/i,
  /\btake your time (and )?think\b/i,
];

// Tier 3 patterns — tasks that require judgment, multi-step reasoning, or document work
const SONNET_PATTERNS = [
  // Multi-step task connectors
  /\band then\b/i,
  /\bafter (that|this)\b/i,
  /\badditionally\b/i,
  /\bin addition\b/i,
  // Document / content analysis
  /\b(analyze|analyse|review|summarize|summarise|interpret)\b/i,
  /\b(syllabus|syllabi|assignment|rubric|schedule)\b/i,
  /\b(read through|go through|look through)\b/i,
  // Decision-making / judgment
  /\b(decide|figure out|determine|compare|evaluate|assess|recommend)\b/i,
  /\bshould i\b/i,
  /\bhelp me choose\b/i,
  /\bpros and cons\b/i,
  /\btrade.?offs?\b/i,
  // Cross-system combinations (scan X AND update Y)
  /\b(blackboard|canvas|bb).{0,60}(calendar|gcal|google cal|schedule)\b/i,
  /\b(scan|check|find|look up).{0,50}(and|then).{0,50}(update|add|send|post|create)\b/i,
];

function generateCacheKey(content: string, groupFolder: string): string {
  const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto
    .createHash('sha256')
    .update(`${groupFolder}:${normalized}`)
    .digest('hex');
}

function stripTrigger(content: string): string {
  return content.replace(/^@\w+\s*/i, '').trim();
}

export function classifyTier(
  messages: NewMessage[],
  groupFolder: string,
  isScheduledTask = false,
): TierDecision {
  // Use non-bot user messages for classification; fall back to all messages for
  // scheduled tasks which have no real sender
  const userMessages = messages.filter(
    (m) => !m.is_from_me && !m.is_bot_message,
  );
  const relevantMessages = userMessages.length > 0 ? userMessages : messages;

  const lastMsg = relevantMessages[relevantMessages.length - 1];
  const primaryContent = stripTrigger(lastMsg?.content ?? '');
  const allContent = relevantMessages.map((m) => m.content).join(' ');
  const cacheKey = generateCacheKey(allContent, groupFolder);

  // Tier 4 check runs first regardless of scheduled/interactive
  for (const pattern of OPUS_TRIGGERS) {
    if (pattern.test(primaryContent)) {
      return {
        tier: 4,
        model: TIER_MODELS[4],
        reason: 'Opus trigger phrase matched',
        cacheable: false,
        cacheKey,
      };
    }
  }

  // Tier 1 only applies to interactive messages (not scheduled tasks)
  if (!isScheduledTask) {
    for (const pattern of GREETING_PATTERNS) {
      if (pattern.test(primaryContent)) {
        return {
          tier: 1,
          model: null,
          instantResponse: `Hey! What can I help you with?`,
          reason: 'greeting',
          cacheable: false,
          cacheKey,
        };
      }
    }

    for (const pattern of ACK_PATTERNS) {
      if (pattern.test(primaryContent)) {
        return {
          tier: 1,
          model: null,
          instantResponse: `Got it.`,
          reason: 'acknowledgment',
          cacheable: false,
          cacheKey,
        };
      }
    }
  }

  // Tier 3: complexity patterns in any of the messages
  for (const pattern of SONNET_PATTERNS) {
    if (pattern.test(allContent)) {
      return {
        tier: 3,
        model: TIER_MODELS[3],
        reason: `Sonnet: complexity pattern matched`,
        cacheable: false,
        cacheKey,
      };
    }
  }

  // Long prompts also escalate to Sonnet (> 300 chars of actual content)
  if (primaryContent.length > 300) {
    return {
      tier: 3,
      model: TIER_MODELS[3],
      reason: `Sonnet: long prompt (${primaryContent.length} chars)`,
      cacheable: false,
      cacheKey,
    };
  }

  // Default: Haiku — cheap, fast, good enough for most tasks
  return {
    tier: 2,
    model: TIER_MODELS[2],
    reason: 'Haiku (default)',
    cacheable: true,
    cacheKey,
  };
}
