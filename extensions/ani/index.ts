import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { aniPlugin } from "./src/channel.js";
import { setAniRuntime } from "./src/runtime.js";
import { createSendFileTool } from "./src/tools.js";

const plugin = {
  id: "ani",
  name: "Agent-Native IM",
  description: "ANI Agent-Native IM channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setAniRuntime(api.runtime);
    // Register tool via BOTH paths for maximum compatibility:
    // 1. api.registerTool() — plugin tools path (resolvePluginTools)
    // 2. agentTools on channel — channel tools path (listChannelAgentTools)
    const sendFileTool = createSendFileTool();
    api.registerTool(sendFileTool);
    api.registerChannel({ plugin: { ...aniPlugin, agentTools: () => [sendFileTool] } });
  },
};

export default plugin;
