import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { aniPlugin } from "./src/channel.js";
import { setAniRuntime } from "./src/runtime.js";

const plugin = {
  id: "ani",
  name: "Agent-Native IM",
  description: "ANI Agent-Native IM channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setAniRuntime(api.runtime);
    api.registerChannel({ plugin: aniPlugin });
  },
};

export default plugin;
