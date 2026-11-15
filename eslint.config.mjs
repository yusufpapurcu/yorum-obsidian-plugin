// Obsidian's review rules (the same plugin its automated directory review uses), applied to the plugin.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "node_modules",
    "docs",
    "sample-vault",
    "tests",
    "main.js",
    "esbuild.config.mjs",
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
