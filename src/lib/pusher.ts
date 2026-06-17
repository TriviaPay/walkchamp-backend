import Pusher from "pusher";

let _client: Pusher | null = null;

export function getPusher(): Pusher {
  if (_client) return _client;
  const { PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER } = process.env;
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) {
    throw new Error("Pusher env vars not configured (PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER)");
  }
  _client = new Pusher({ appId: PUSHER_APP_ID, key: PUSHER_KEY, secret: PUSHER_SECRET, cluster: PUSHER_CLUSTER, useTLS: true });
  return _client;
}

export function isPusherConfigured(): boolean {
  return !!(process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER);
}

/** Fire-and-forget — never throw on Pusher errors so the main request succeeds. */
export async function triggerEvent(channel: string, event: string, data: unknown): Promise<void> {
  if (!isPusherConfigured()) return;
  try {
    await getPusher().trigger(channel, event, data);
  } catch (_err) {
    // Pusher is best-effort — swallow errors silently
  }
}
