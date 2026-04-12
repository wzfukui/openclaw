import { format } from "node:util";
import { getAniRuntime } from "../runtime.js";
import type { RuntimeEnv } from "../sdk-compat.js";
import type { CoreConfig } from "../types.js";
import { normalizeAniServerUrl } from "../utils.js";
import { createAniMessageHandler } from "./handler.js";
import { flushPendingAniMessages, verifyAniConnection } from "./send.js";

export type MonitorAniOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string | null;
};

export const ANI_PING_INTERVAL_MS = 30000;
export const ANI_FLUSH_INTERVAL_MS = 60000;
export const ANI_STALE_SOCKET_TIMEOUT_MS = 120000;
export const ANI_STALE_SOCKET_CHECK_INTERVAL_MS = 15000;

export function isAniSocketStale(opts: {
  now: number;
  lastPongAt: number;
  lastMessageAt: number;
  timeoutMs?: number;
}): boolean {
  const latestSignal = Math.max(opts.lastPongAt, opts.lastMessageAt);
  return opts.now - latestSignal > (opts.timeoutMs ?? ANI_STALE_SOCKET_TIMEOUT_MS);
}

/**
 * Gateway entry point: connects to ANI via WebSocket, listens for messages,
 * routes them through the OpenClaw AI agent, and delivers replies back.
 */
export async function monitorAniProvider(opts: MonitorAniOpts = {}): Promise<void> {
  const core = getAniRuntime();
  const cfg = core.config.loadConfig() as CoreConfig;
  const aniCfg = cfg.channels?.ani;
  if (!aniCfg || aniCfg.enabled === false) return;

  const serverUrl = normalizeAniServerUrl(aniCfg.serverUrl);
  const apiKey = aniCfg.apiKey ?? "";
  if (!serverUrl || !apiKey) {
    throw new Error("ANI requires serverUrl and apiKey in channels.ani config");
  }
  if (apiKey.startsWith("aimb_")) {
    throw new Error(
      "ANI apiKey must be a permanent key (aim_ prefix). Legacy aimb_ keys are no longer supported.",
    );
  }

  const logger = core.logging.getChildLogger({ module: "ani-channel" });
  const formatMsg = (...args: Parameters<RuntimeEnv["log"]>) => format(...args);
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => logger.info(formatMsg(...args)),
    error: (...args) => logger.error(formatMsg(...args)),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const logVerbose = (message: string) => {
    if (!core.logging.shouldLogVerbose()) return;
    logger.debug?.(message);
  };

  // Verify connection before starting WebSocket
  logger.info("ani: verifying connection...");
  const me = await verifyAniConnection({ serverUrl, apiKey });
  logger.info(`ani: authenticated as entity ${me.entityId} (${me.name})`);

  const handleMessage = createAniMessageHandler({
    core,
    cfg,
    runtime,
    logger: {
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
    },
    logVerbose,
    serverUrl,
    apiKey,
    selfEntityId: me.entityId,
    selfName: me.name,
    accountId: opts.accountId ?? "default",
  });

  // Build WebSocket URL
  const wsProto = serverUrl.startsWith("https") ? "wss" : "ws";
  const wsHost = serverUrl.replace(/^https?:\/\//, "");
  const wsUrl = `${wsProto}://${wsHost}/api/v1/ws`;

  // Dynamic import ws (Node.js WebSocket library)
  const { default: WebSocket } = await import("ws");

  let ws: InstanceType<typeof WebSocket> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isShuttingDown = false;
  // Exponential backoff with jitter for reconnection
  const BACKOFF_BASE_MS = 1000;
  const BACKOFF_MAX_MS = 60000;
  const BACKOFF_JITTER = 0.25; // 0-25% random jitter
  let backoffAttempt = 0;

  function getReconnectDelay(): number {
    const exponential = Math.min(BACKOFF_BASE_MS * Math.pow(2, backoffAttempt), BACKOFF_MAX_MS);
    const jitter = exponential * BACKOFF_JITTER * Math.random();
    return Math.round(exponential + jitter);
  }

  function connect() {
    if (isShuttingDown) return;

    logVerbose("ani: connecting WebSocket...");
    ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
    let lastPongAt = Date.now();
    let lastMessageAt = Date.now();

    ws.on("open", () => {
      logger.info("ani: WebSocket connected");
      // Reset backoff on successful connection
      backoffAttempt = 0;
      lastPongAt = Date.now();
      lastMessageAt = lastPongAt;
      void flushPendingAniMessages({
        serverUrl,
        apiKey,
        accountId: opts.accountId ?? "default",
        logger: {
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
        },
      }).catch((err) => {
        logger.warn(`ani: failed to flush pending outbound messages: ${String(err)}`);
      });
      // Start ping keep-alive
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, ANI_PING_INTERVAL_MS);
      flushTimer = setInterval(() => {
        void flushPendingAniMessages({
          serverUrl,
          apiKey,
          accountId: opts.accountId ?? "default",
          logger: {
            info: (message) => logger.info(message),
            warn: (message) => logger.warn(message),
          },
        }).catch((err) => {
          logger.warn(`ani: periodic flush failed: ${String(err)}`);
        });
      }, ANI_FLUSH_INTERVAL_MS);
      staleCheckTimer = setInterval(() => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        if (
          !isAniSocketStale({
            now: Date.now(),
            lastPongAt,
            lastMessageAt,
          })
        ) {
          return;
        }
        logger.warn("ani: stale WebSocket detected, forcing reconnect");
        try {
          ws.terminate();
        } catch (err) {
          logger.warn(`ani: failed to terminate stale socket: ${String(err)}`);
        }
      }, ANI_STALE_SOCKET_CHECK_INTERVAL_MS);
    });

    ws.on("pong", () => {
      lastPongAt = Date.now();
      logVerbose("ani: pong received");
    });

    ws.on("message", (data) => {
      (async () => {
        lastMessageAt = Date.now();
        const raw = typeof data === "string" ? data : data.toString("utf-8");
        logVerbose(`ani: WS message received: ${raw.slice(0, 200)}`);
        const msg = JSON.parse(raw);
        await handleMessage(msg);
      })().catch((err) => {
        logger.warn(`ani: WebSocket message handler error: ${String(err)}`);
      });
    });

    ws.on("close", (code, reason) => {
      if (pingTimer) clearInterval(pingTimer);
      if (flushTimer) clearInterval(flushTimer);
      if (staleCheckTimer) clearInterval(staleCheckTimer);
      if (isShuttingDown) return;
      const delay = getReconnectDelay();
      backoffAttempt++;
      logger.info(
        `ani: WebSocket closed (code=${code}), reconnecting in ${delay}ms (attempt ${backoffAttempt})...`,
      );
      reconnectTimer = setTimeout(connect, delay);
    });

    ws.on("error", (err) => {
      runtime.error?.(`ani: WebSocket error: ${String(err)}`);
    });
  }

  connect();

  // Wait for abort signal (shutdown)
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      isShuttingDown = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close(1000, "shutdown");
        } catch {
          // ignore
        }
      }
      resolve();
    };
    if (opts.abortSignal?.aborted) {
      onAbort();
      return;
    }
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
