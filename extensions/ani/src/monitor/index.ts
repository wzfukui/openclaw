import { format } from "node:util";

import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";

import type { AniConfig, CoreConfig } from "../types.js";
import { getAniRuntime } from "../runtime.js";
import { sendAniMessage, verifyAniConnection } from "./send.js";
import { createAniMessageHandler } from "./handler.js";

export type MonitorAniOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string | null;
};

/**
 * Gateway entry point: connects to ANI via WebSocket, listens for messages,
 * routes them through the OpenClaw AI agent, and delivers replies back.
 */
export async function monitorAniProvider(opts: MonitorAniOpts = {}): Promise<void> {
  const core = getAniRuntime();
  const cfg = core.config.loadConfig() as CoreConfig;
  const aniCfg = cfg.channels?.ani;
  if (!aniCfg || aniCfg.enabled === false) return;

  const serverUrl = (aniCfg.serverUrl ?? "").replace(/\/+$/, "");
  const apiKey = aniCfg.apiKey ?? "";
  if (!serverUrl || !apiKey) {
    throw new Error("ANI requires serverUrl and apiKey in channels.ani config");
  }
  if (apiKey.startsWith("aimb_")) {
    throw new Error(
      "ANI apiKey must be a permanent key (aim_ prefix). Bootstrap keys (aimb_) are not supported. " +
        "Connect via WebSocket first to upgrade your key. See: /api/v1/onboarding-guide",
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
    logger.debug(message);
  };

  // Verify connection before starting WebSocket
  logger.info("ani: verifying connection...");
  const me = await verifyAniConnection({ serverUrl, apiKey });
  logger.info(`ani: authenticated as entity ${me.entityId} (${me.name})`);

  const handleMessage = createAniMessageHandler({
    core,
    cfg,
    runtime,
    logger,
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
  const wsUrl = `${wsProto}://${wsHost}/api/v1/ws?token=${apiKey}`;

  // Dynamic import ws (Node.js WebSocket library)
  const { default: WebSocket } = await import("ws");

  let ws: InstanceType<typeof WebSocket> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isShuttingDown = false;
  const RECONNECT_DELAY_MS = 5000;
  const PING_INTERVAL_MS = 30000;

  function connect() {
    if (isShuttingDown) return;

    logVerbose("ani: connecting WebSocket...");
    ws = new WebSocket(wsUrl);

    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.on("open", () => {
      logger.info("ani: WebSocket connected");
      // Start ping keep-alive
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, PING_INTERVAL_MS);
    });

    ws.on("pong", () => {
      logVerbose("ani: pong received");
    });

    ws.on("message", (data) => {
      try {
        const raw = typeof data === "string" ? data : data.toString("utf-8");
        logVerbose(`ani: WS message received: ${raw.slice(0, 200)}`);
        const msg = JSON.parse(raw);
        handleMessage(msg).catch((err) => {
          runtime.error?.(`ani: handler error: ${String(err)}`);
        });
      } catch (err) {
        logVerbose(`ani: failed to parse WS message: ${String(err)}`);
      }
    });

    ws.on("close", (code, reason) => {
      if (pingTimer) clearInterval(pingTimer);
      if (isShuttingDown) return;
      logger.info(`ani: WebSocket closed (code=${code}), reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
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
