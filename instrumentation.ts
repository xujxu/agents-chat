export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureRuntime } = await import("./lib/scheduler/schedulerRuntime");
  await ensureRuntime();
  void warmUpTeamsBot();
  try {
    const { startShareReminders } = await import("./lib/channels/teams/shareReminders");
    startShareReminders();
  } catch {
    // Reminders are optional; the in-app notices still work.
  }
}

/** Pre-fetch Teams bot credentials so the first Teams message after a restart replies quickly. */
async function warmUpTeamsBot() {
  try {
    const { getTeamsConfig } = await import("./lib/channels/teams/config");
    const config = getTeamsConfig();
    if (!config) return;
    const [{ warmUpTeams }, { createLogger }] = await Promise.all([
      import("./lib/channels/teams/auth"),
      import("./lib/logger"),
    ]);
    const logger = createLogger("teams-bot");
    const startedAt = Date.now();
    let failed = false;
    await warmUpTeams(config, {
      onError: (stage, err) => {
        failed = true;
        logger.warn({ stage, err: err instanceof Error ? err.message : String(err) }, "Teams warm-up step failed");
      },
    });
    if (!failed) logger.info({ ms: Date.now() - startedAt }, "Teams bot credentials warmed up");
  } catch {
    // Warm-up is an optimization only; requests fetch credentials on demand.
  }
}
