import { NextRequest, NextResponse } from 'next/server';
import * as configStore from '@/lib/configStore';
import { getAuthToken, getUserEmail } from '@/lib/auth';
import { canUseAgent, getUserRole } from '@/lib/rbac';
import { sendShareReminders } from '@/lib/channels/teams/shareReminders';

export const dynamic = 'force-dynamic';

const REMIND_DAYS = configStore.SHARE_REMIND_DAYS;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

/** GET — the caller's own grants (for expiry notices) and, for admins, pending extension requests. */
export async function GET(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token) return json({ ok: false, error: 'unauthorized' }, 401);
  const role = getUserRole(token);
  if (!role) return json({ ok: false, error: 'not_authorized' }, 403);
  const email = getUserEmail(token);
  return json({
    ok: true,
    remindDays: REMIND_DAYS,
    grants: email ? configStore.listUserAgentGrants(email) : [],
    extensionRequests: role === 'admin' ? configStore.listAgentAccessExtensionRequests() : [],
  });
}

/**
 * POST actions:
 * - `accept` { token }: open a share link; works only for accounts on that agent's access list.
 * - `request-extension` { agentId, days }: ask an admin for more days on your own grant.
 * - admin only: `get-link` / `create-link` / `revoke-link` { agentId },
 *   `extend` / `approve-extension` { agentId, email, days? }, `deny-extension` { agentId, email }.
 */
export async function POST(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token) return json({ ok: false, error: 'unauthorized' }, 401);
  const role = getUserRole(token);
  if (!role) return json({ ok: false, error: 'not_authorized' }, 403);
  const email = getUserEmail(token);
  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : '';
  const agentId = typeof body?.agentId === 'string' ? body.agentId : '';

  if (action === 'accept') {
    const shareToken = typeof body?.token === 'string' ? body.token : '';
    const sharedAgentId = configStore.getAgentIdByShareToken(shareToken);
    const agent = sharedAgentId ? configStore.getAgentById(sharedAgentId) : null;
    if (!agent) return json({ ok: false, error: 'invalid_link' }, 404);
    const accepted = !!email && configStore.acceptAgentInvite(agent.id, email);
    if (!accepted && !canUseAgent(token, agent)) {
      const grant = email ? configStore.getAgentAccess(agent.id, email) : null;
      return json({ ok: false, error: grant?.status === 'expired' ? 'expired' : 'not_invited' }, 403);
    }
    if (email) configStore.setUserLastUsedAgent(email, agent.id);
    return json({ ok: true, agentId: agent.id, agentName: agent.name || agent.id });
  }

  if (action === 'request-extension') {
    const days = Number(body?.days ?? configStore.SHARE_DAYS);
    if (!agentId || !email) return json({ ok: false, error: 'missing_agentId' }, 400);
    if (!configStore.requestAgentAccessExtension(agentId, email, days)) return json({ ok: false, error: 'not_allowed' }, 400);
    // Tell admins in Teams now rather than at the next hourly check; best-effort.
    void sendShareReminders().catch(() => undefined);
    return json({ ok: true });
  }

  if (role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);
  if (!agentId) return json({ ok: false, error: 'missing_agentId' }, 400);
  if (!configStore.getAgentById(agentId)) return json({ ok: false, error: 'agent_not_found' }, 404);

  if (action === 'get-link') return json({ ok: true, token: configStore.getAgentShareToken(agentId) });
  if (action === 'create-link') return json({ ok: true, token: configStore.rotateAgentShareToken(agentId, email || 'admin') });
  if (action === 'revoke-link') {
    configStore.revokeAgentShareToken(agentId);
    return json({ ok: true, token: null });
  }

  const target = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!target) return json({ ok: false, error: 'missing_email' }, 400);
  if (action === 'extend' || action === 'approve-extension') {
    const requested = configStore.getAgentAccess(agentId, target)?.extensionDays;
    const days = Number(body?.days ?? (action === 'approve-extension' && requested ? requested : configStore.SHARE_DAYS));
    if (!configStore.extendAgentAccess(agentId, target, days)) return json({ ok: false, error: 'invalid_request' }, 400);
    return json({ ok: true });
  }
  if (action === 'deny-extension') {
    if (!configStore.denyAgentAccessExtension(agentId, target)) return json({ ok: false, error: 'not_found' }, 404);
    return json({ ok: true });
  }
  return json({ ok: false, error: 'unknown_action' }, 400);
}
