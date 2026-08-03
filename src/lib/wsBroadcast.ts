const WS_INTERNAL_URL = process.env.WS_INTERNAL_URL ?? "http://localhost:8080";
const WS_INTERNAL_SECRET = process.env.WS_INTERNAL_SECRET ?? "";

/**
 * Fans a REST-originated change out to connected WebSocket clients.
 * ws-server.js exposes POST /internal/broadcast on the same HTTP server it
 * upgrades WS connections on — this is how REST and WS, which run as
 * separate processes, stay in sync without polling. Best-effort: a
 * REST write must succeed even if the WS process is briefly unreachable.
 */
export async function notifyWs(event: string, payload: unknown): Promise<void> {
  try {
    await fetch(`${WS_INTERNAL_URL}/internal/broadcast`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": WS_INTERNAL_SECRET
      },
      body: JSON.stringify({ event, payload }),
      signal: AbortSignal.timeout(2000)
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "ws broadcast failed",
        event,
        error: err instanceof Error ? err.message : String(err)
      })
    );
  }
}
