import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { aniPlugin } from "./src/channel.js";
import { setAniRuntime } from "./src/runtime.js";
import { createSendFileTool, createGetHistoryTool } from "./src/tools.js";
// Tool names: ani_send_file, ani_fetch_chat_messages

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
    const getHistoryTool = createGetHistoryTool();
    api.registerTool(sendFileTool);
    api.registerTool(getHistoryTool);
    api.registerChannel({ plugin: { ...aniPlugin, agentTools: () => [sendFileTool, getHistoryTool] } });
  },
};

export default plugin;
