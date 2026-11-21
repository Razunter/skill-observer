import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
