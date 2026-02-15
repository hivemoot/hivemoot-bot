import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["api/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        statements: 79,
        branches: 82,
        functions: 89,
        lines: 79,
      },
    },
  },
});
