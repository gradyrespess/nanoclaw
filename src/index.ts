import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllPendingBudgetTransactions,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  findPendingBudgetTransactionByMerchant,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { classifyTier } from './tier-router.js';
import {
  estimateTokens,
  getWeeklyCostReport,
  logTierUsage,
} from './cost-tracker.js';
import { getCacheEntry, setCacheEntry } from './db.js';
import { BudgetTracker } from './budget-tracker.js';
import { MorningBriefing } from './morning-briefing.js';
import { BlackboardPortal } from './blackboard-portal.js';
import { SmsChannel } from './channels/sms.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

export { formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let budgetTracker: BudgetTracker | null = null;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // --- Tier classification ---
  const tierDecision = classifyTier(missedMessages, group.folder, false);
  logger.info(
    { group: group.name, tier: tierDecision.tier, reason: tierDecision.reason },
    'Tier classified',
  );

  // Tier 1: instant response — no API call, no container
  if (tierDecision.tier === 1 && tierDecision.instantResponse) {
    await channel.sendMessage(chatJid, tierDecision.instantResponse);
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    logTierUsage({
      tier: 1,
      model: null,
      groupFolder: group.folder,
      isCacheHit: false,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      promptPreview: missedMessages[missedMessages.length - 1].content,
    });
    return true;
  }

  // Cache check for Tier 2 (cacheable) responses
  if (tierDecision.cacheable) {
    const cached = getCacheEntry(tierDecision.cacheKey);
    if (cached) {
      await channel.sendMessage(chatJid, cached);
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      logger.info(
        { group: group.name, tier: tierDecision.tier },
        'Cache hit — skipped API call',
      );
      logTierUsage({
        tier: tierDecision.tier,
        model: tierDecision.model,
        groupFolder: group.folder,
        isCacheHit: true,
        estimatedInputTokens: estimateTokens(
          missedMessages.map((m) => m.content).join(' '),
        ),
        estimatedOutputTokens: 0,
        promptPreview: missedMessages[missedMessages.length - 1].content,
      });
      return true;
    }
  }

  const basePrompt = formatMessages(missedMessages, TIMEZONE);
  const budgetContext = isMainGroup ? getBudgetContext(missedMessages) : null;
  const prompt = budgetContext
    ? `${budgetContext}\n\n${basePrompt}`
    : basePrompt;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let agentResponse = '';

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    tierDecision.model ?? undefined,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          agentResponse += text;
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Log tier usage after we know the response size
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(agentResponse);
  logTierUsage({
    tier: tierDecision.tier,
    model: tierDecision.model,
    groupFolder: group.folder,
    isCacheHit: false,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    promptPreview: prompt.slice(0, 120),
  });

  // Cache Tier 2 responses that succeeded and produced output
  if (
    tierDecision.cacheable &&
    agentResponse &&
    output !== 'error' &&
    !hadError
  ) {
    setCacheEntry(tierDecision.cacheKey, agentResponse);
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  model?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        model,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const baseFormatted = formatMessages(messagesToSend, TIMEZONE);
          const pipeBudgetCtx = group.isMain
            ? getBudgetContext(messagesToSend)
            : null;
          const formatted = pipeBudgetCtx
            ? `${pipeBudgetCtx}\n\n${baseFormatted}`
            : baseFormatted;

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

const BUDGET_QUERY_SCRIPT = path.join(
  process.cwd(),
  'scripts',
  'budget-query.py',
);

function getBudgetContext(_messages: NewMessage[]): string | null {
  try {
    const run = (args: string) =>
      execSync(`python3 ${BUDGET_QUERY_SCRIPT} ${args}`, { timeout: 8000 })
        .toString()
        .trim();

    const week = run('week');
    const pending = run('pending');
    const recent = run('recent 15');

    return [
      "=== Budget Data (live from local database — use this to answer Grady's question) ===",
      week,
      '',
      pending,
      '',
      recent,
      '=== End Budget Data ===',
    ].join('\n');
  } catch (err) {
    logger.warn({ err }, 'Budget context query failed');
    return null;
  }
}

function ensureContainerSystemRunning(): void {
  const runtimeAvailable = ensureContainerRuntimeRunning();
  if (runtimeAvailable) {
    cleanupOrphans();
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // /cost command handler — replies with estimated spend for the last 7 days
  async function handleCostCommand(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    try {
      const report = getWeeklyCostReport();
      await channel.sendMessage(chatJid, report);
    } catch (err) {
      logger.error({ err, chatJid }, 'Cost report error');
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onRegisterGroup: (jid: string, group: RegisteredGroup) =>
      registerGroup(jid, group),
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Cost report command — intercept before storage (registered groups only)
      if (trimmed === '/cost' && registeredGroups[chatJid]) {
        handleCostCommand(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Cost command error'),
        );
        return;
      }

      // Budget tracker manual poll — main group only, no trigger required
      if (
        /^(check (my )?transactions?|check (my )?spending|show (my )?transactions?|what did i spend|show (my )?charges)$/i.test(
          trimmed,
        ) &&
        registeredGroups[chatJid]?.isMain
      ) {
        if (budgetTracker) {
          const channel = findChannel(channels, chatJid);
          budgetTracker
            .pollNow(
              (text) =>
                channel?.sendMessage(chatJid, text) ?? Promise.resolve(),
            )
            .catch((err) =>
              logger.error({ err, chatJid }, 'Budget pollNow error'),
            );
        }
        return;
      }

      // ── Budget intercepts (main group only, handled before agent sees them) ──
      // NOTE: Pattern matching is gated on isMain only — NOT on budgetTracker being non-null.
      // This ensures budget commands always return here and never reach the agent, even if
      // budgetTracker failed to initialize.
      if (registeredGroups[chatJid]?.isMain) {
        const clean = trimmed.replace(/^\[Reply to [^\]]+\]\s*/i, '').trim();
        const channel = findChannel(channels, chatJid);
        const send = (text: string) =>
          channel
            ?.sendMessage(chatJid, text)
            .catch((err) =>
              logger.error({ err, chatJid }, 'Budget reply send error'),
            );
        const notReady = () => {
          send('Budget tracker is not running right now.');
        };

        // Tier 1: YES T1 / NO T1 — explicit short-id
        const shortIdMatch = clean.match(/^(YES|NO)\s+(T\d+)$/i);
        if (shortIdMatch) {
          if (budgetTracker) {
            budgetTracker
              .handleReply(
                shortIdMatch[1].toUpperCase() as 'YES' | 'NO',
                shortIdMatch[2].toUpperCase(),
              )
              .then((reply) => {
                if (reply) send(reply);
              })
              .catch((err) =>
                logger.error({ err, chatJid }, 'Budget handleReply error'),
              );
          } else {
            notReady();
          }
          return;
        }

        // Tier 2: Log all — always fires, no pending check
        if (
          /^(add|log|do)\s+(them\s+)?all$|^yes\s+to\s+all$|^(add|log)\s+everything$|^all\s+of\s+(them|those)$|^do\s+them\s+all$|^(add|log)\s+those$|^(add|log)\s+all\s+(of\s+)?(them|those)$/i.test(
            clean,
          )
        ) {
          if (budgetTracker) {
            budgetTracker
              .handleLogAll()
              .then(send)
              .catch((err) =>
                logger.error({ err, chatJid }, 'Budget handleLogAll error'),
              );
          } else {
            notReady();
          }
          return;
        }

        // Tier 3: Log most recent — always fires, no pending check
        if (
          /^(add|log)\s+it$|^(add|log)\s+that(\s+one)?$|^(add|log)\s+this(\s+one)?$|^that\s+one$|^this\s+one$|^yeah\s+(add|log)\s+it$|^yes\s+(add|log)\s+it$/i.test(
            clean,
          )
        ) {
          if (budgetTracker) {
            budgetTracker
              .handleLogMostRecent()
              .then((reply) => {
                if (reply) send(reply);
              })
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Budget handleLogMostRecent error',
                ),
              );
          } else {
            notReady();
          }
          return;
        }

        // Tier 4: "add/log [merchant]" — fires if a matching pending tx exists
        const merchantMatch = clean.match(/^(?:add|log)\s+(.+)$/i);
        if (merchantMatch) {
          const term = merchantMatch[1].trim();
          if (
            !/^T\d+$/i.test(term) &&
            findPendingBudgetTransactionByMerchant(term)
          ) {
            if (budgetTracker) {
              budgetTracker
                .handleLogByMerchant(term)
                .then((reply) => {
                  if (reply) send(reply);
                })
                .catch((err) =>
                  logger.error(
                    { err, chatJid },
                    'Budget handleLogByMerchant error',
                  ),
                );
            } else {
              notReady();
            }
            return;
          }
        }

        // Tier 5: Generic confirmations — only fire when pending transactions exist
        if (
          /^(yeah|yep|yup|yes|sure|ok|okay|go\s+ahead|sounds\s+good|definitely|absolutely|do\s+it|yes\s+please)$/i.test(
            clean,
          )
        ) {
          if (getAllPendingBudgetTransactions().length > 0) {
            if (budgetTracker) {
              budgetTracker
                .handleLogMostRecent()
                .then((reply) => {
                  if (reply) send(reply);
                })
                .catch((err) =>
                  logger.error(
                    { err, chatJid },
                    'Budget handleLogMostRecent error',
                  ),
                );
            } else {
              notReady();
            }
            return;
          }
        }
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Blackboard portal — attach to the SMS webhook server on port 3002
  const smsChannel = channels.find(
    (c): c is SmsChannel => c instanceof SmsChannel,
  );
  if (smsChannel) {
    const portal = new BlackboardPortal();
    portal.setNotifyCallback(async (jids, message) => {
      for (const jid of jids) {
        // 'discord_main' is a logical alias — resolve to the actual Discord main group JID
        let targetJid = jid;
        if (jid === 'discord_main') {
          const mainEntry = Object.entries(registeredGroups).find(
            ([, g]) => g.isMain,
          );
          if (!mainEntry) continue;
          targetJid = mainEntry[0];
        }
        const ch = findChannel(channels, targetJid);
        if (ch) {
          await ch
            .sendMessage(targetJid, message)
            .catch((err) =>
              logger.error(
                { err, jid: targetJid },
                'Portal: failed to send expiry notification',
              ),
            );
        }
      }
    });
    smsChannel.setPortal(portal);
    logger.info('Blackboard portal attached to SMS webhook server (port 3002)');
  } else {
    logger.warn(
      'Blackboard portal: SMS channel not running — portal unavailable',
    );
  }

  // Budget tracker (Gmail → Discord → Sheets)
  try {
    budgetTracker = new BudgetTracker(
      async (jid, text) => {
        const channel = findChannel(channels, jid);
        if (channel) await channel.sendMessage(jid, text);
      },
      ['sms:+18642756439'],
    );
    budgetTracker.start();
  } catch (err) {
    logger.warn(
      { err },
      'Budget tracker disabled (check GOOGLE_TOKEN_PATH and re-run gcal-auth.mjs)',
    );
  }

  // Morning briefing (calendar + weather + spending — daily at 7:30am)
  try {
    const morningBriefing = new MorningBriefing(
      async (jid, text) => {
        const channel = findChannel(channels, jid);
        if (channel) await channel.sendMessage(jid, text);
      },
      ['sms:+18642756439'],
    );
    morningBriefing.start();
  } catch (err) {
    logger.warn({ err }, 'Morning briefing disabled (check GOOGLE_TOKEN_PATH)');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: async (jid, text, filePath) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendFile) {
        await channel.sendFile(jid, text, filePath);
      } else {
        await channel.sendMessage(jid, text || '(screenshot attached)');
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
