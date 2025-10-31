import { configDefaults, defineConfig } from "vitest/config.js";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(() => {
  /** @type {import("vitest/config.js").UserConfigExport} */
  return {
    test: {
      hideSkippedTests: true,
      testTimeout: 30_000,
      fileParallelism: false,
    },
  };
});
