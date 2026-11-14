// Obsidian's review rules (the same plugin its automated directory review uses), applied to the
// plugin and the shared core it bundles. Web-app-only code (server, browser UI) isn't plugin code.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "node_modules",
    "dist",
    "docs",
    "public",
    "sample-vault",
    "tests",
    "src/node",
    "src/server.ts",
    "src/index.ts",
    "obsidian-plugin/main.js",
    "obsidian-plugin/esbuild.config.mjs",
    "vitest.config.*",
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.*"] },
      },
    },
  },
]);
