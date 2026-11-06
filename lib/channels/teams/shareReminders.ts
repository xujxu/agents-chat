import * as configStore from '@/lib/configStore';
import { createLogger } from '@/lib/logger';
import { getTeamsConfig, type TeamsConfig } from './config';
import { ConnectorError, sendText } from './connector';
import { parseEmailList } from './util';

const logger = createLogger('teams-bot');

const CHECK_INTERVAL_MS = 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;

type Globals = {
  __teamsShareReminderTimer?: ReturnType<typeof setInterval>;
  __teamsShareReminderRun?: Promise<ReminderResult>;
  __teamsShareReminderRerun?: boolean;
};
const g = globalThis as Globals;

export type ReminderResult = { sent: number; failed: number };

/**
 * Sends Teams messages about agent sharing, each at most once:
 * - recipients: their access to a shared agent expires within SHARE_REMIND_DAYS;
 * - admins: someone asked for more days.
 * Only people in TEAMS_ALLOWED_USERS who have chatted 1:1 with the bot can be reached; everyone else
 * still sees the in-app notice. Failed sends are retried on the next run.
 */
export function sendShareReminders(config: TeamsConfig | null = getTeamsConfig()): Promise<ReminderResult> {
  if (!config) return Promise.resolve({ sent: 0, failed: 0 });
  // One run at a time, so a request-triggered run and the hourly run never send the same message twice.
  // A call during a run queues one more run, so changes made meanwhile are not left for the next hour.
  if (g.__teamsShareReminderRun) {
    g.__teamsShareReminderRerun = true;
    return g.__teamsShareReminderRun;
  }
  g.__teamsShareReminderRun = run(config).finally(() => {
    g.__teamsShareReminderRun = undefined;
    if (g.__teamsShareReminderRerun) {
      g.__teamsShareReminderRerun = false;
      void sendShareReminders(config).catch((err) => logger.warn({ err: errorText(err) }, 'Teams share reminders failed'));
    }
  });
  return g.__teamsShareReminderRun;
}

/** Hourly checks for the life of the server; a no-op without Teams configuration or when already started. */
export function startShareReminders(): void {
  if (g.__teamsShareReminderTimer || !getTeamsConfig()) return;
  const tick = () => { void sendShareReminders().catch((err) => logger.warn({ err: errorText(err) }, 'Teams share reminders failed')); };
  setTimeout(tick, FIRST_CHECK_DELAY_MS).unref?.();
  g.__teamsShareReminderTimer = setInterval(tick, CHECK_INTERVAL_MS);
  g.__teamsShareReminderTimer.unref?.();
}

async function run(config: TeamsConfig): Promise<ReminderResult> {
  const result: ReminderResult = { sent: 0, failed: 0 };
  const appUrl = publicAppUrl();

  for (const grant of configStore.listGrantsDueForTeamsReminder()) {
    const text = [
      `⏰ Your access to the **${grant.agentName}** agent ${expiresIn(grant.expiresAt)} (${formatDate(grant.expiresAt)}).`,
      `To keep using it, send \`/extend\` here, or ${appUrl ? `open [agents-chat](${appUrl})` : 'open agents-chat'} and choose **Request 30 more days** on the notice.`,
    ].join('\n\n');
    if (await notify(config, grant.email, text, result)) {
      configStore.markTeamsExpiryReminded(grant.agentId, grant.email, grant.expiresAt);
    }
  }

  const requests = configStore.listExtensionRequestsDueForTeamsNotice();
  if (requests.length) {
    const admins = adminEmails();
    for (const request of requests) {
      const text = [
        `📝 **${request.email}** asked for ${request.extensionDays} more days on the **${request.agentName}** agent (access ${request.status === 'expired' ? 'expired' : 'expires'} ${formatDate(request.expiresAt)}).`,
        `Send \`/approve\` or \`/deny\` here, or ${appUrl ? `open [agents-chat](${appUrl})` : 'open agents-chat'}, to decide.`,
      ].join('\n\n');
      let delivered = false;
      for (const admin of admins) {
        if (await notify(config, admin, text, result)) delivered = true;
      }
      if (delivered) configStore.markTeamsExtensionNotified(request.agentId, request.email, request.extensionRequestedAt || '');
    }
  }

  if (result.sent || result.failed) logger.info(result, 'Teams share reminders sent');
  return result;
}

/**
 * Tells the recipient in Teams that an admin approved or denied their extension request. Best-effort:
 * sent once, only if they are reachable; the web UI shows the new expiry either way.
 */
export async function notifyExtensionDecision(
  grant: { agentId: string; email: string },
  approved: boolean,
  config: TeamsConfig | null = getTeamsConfig(),
): Promise<boolean> {
  if (!config) return false;
  const agent = configStore.getAgentById(grant.agentId);
  const agentName = agent?.name || grant.agentId;
  const access = configStore.getAgentAccess(grant.agentId, grant.email);
  const text = approved
    ? `✅ Your request was approved: you can use the **${agentName}** agent until ${access ? formatDate(access.expiresAt) : 'the new expiry date'}.`
    : `❌ Your request for more days on the **${agentName}** agent was denied. Ask an admin if you still need it.`;
  return notify(config, grant.email, text, { sent: 0, failed: 0 });
}

/** True when the message was delivered. People the bot cannot reach are skipped quietly. */
async function notify(config: TeamsConfig, email: string, text: string, result: ReminderResult): Promise<boolean> {
  if (!config.allowedUsers.includes(email.toLowerCase())) return false;
  const conversation = configStore.getTeamsConversation(email);
  if (!conversation) return false;
  try {
    await sendText(config, conversation, text);
    result.sent++;
    return true;
  } catch (err) {
    result.failed++;
    // 403/404: the person removed the bot or the chat is gone; forget it until they message the bot again.
    if (err instanceof ConnectorError && (err.status === 403 || err.status === 404)) {
      configStore.removeTeamsConversation(email, conversation.conversationId);
    }
    logger.warn({ email, err: errorText(err) }, 'Teams share reminder not delivered');
    return false;
  }
}

function adminEmails(): string[] {
  const emails = new Set(parseEmailList(process.env.ADMIN_EMAILS));
  for (const role of configStore.listUserRoles()) if (role.role === 'admin') emails.add(role.email);
  return [...emails];
}

function publicAppUrl(): string {
  const url = (process.env.NEXTAUTH_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(url) ? url : '';
}

function expiresIn(iso: string): string {
  const days = Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60_000)));
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
