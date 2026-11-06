import { NextRequest, NextResponse } from 'next/server';
import { verifyInboundToken } from '@/lib/channels/teams/auth';
import { handleActivity, markActivityProcessed, type TeamsActivity } from '@/lib/channels/teams/bridge';
import { getTeamsConfig } from '@/lib/channels/teams/config';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logger = createLogger('teams-route');

/** Bot Framework messaging endpoint for the Microsoft Teams bot. */
export async function POST(req: NextRequest) {
  const config = getTeamsConfig();
  if (!config) return NextResponse.json({ error: 'teams_not_configured' }, { status: 404 });

  let activity: TeamsActivity;
  try {
    activity = await req.json() as TeamsActivity;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    await verifyInboundToken(req.headers.get('authorization'), config, activity?.serviceUrl);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Rejected Teams activity with invalid token');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (activity?.channelId !== 'msteams') {
    return new NextResponse(null, { status: 200 });
  }

  // Acknowledge immediately; Bot Framework retries when a reply takes longer than ~15s.
  if (markActivityProcessed(activity.id)) {
    void handleActivity(activity, config).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Teams activity processing failed');
    });
  }
  return new NextResponse(null, { status: 200 });
}
