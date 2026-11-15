// Bundles the plugin into main.js, where Obsidian's scorecard looks for it after `npm run build`.
// `--production` (`npm run build`, releases) leaves out the inline source map so the build is reproducible.
// `--install /path/to/vault` also copies main.js, styles.css and manifest.json into
// <vault>/.obsidian/plugins/yorum/ so Obsidian can load it.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: [path.join(here, "src", "main.ts")],
  bundle: true,
  outfile: path.join(here, "main.js"),
  format: "cjs",
  platform: "browser",
  target: "es2022",
  // Provided by Obsidian at runtime (Node builtins: desktop only, loaded on demand).
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "node:http", "node:https"],
  logLevel: "info",
  sourcemap: production ? false : "inline",
});

const installAt = process.argv.indexOf("--install");
if (installAt !== -1) {
  const vault = process.argv[installAt + 1];
  if (!vault) throw new Error("--install needs a vault folder");
  const target = path.join(path.resolve(vault), ".obsidian", "plugins", "yorum");
  await mkdir(target, { recursive: true });
  const files = [path.join(here, "main.js"), path.join(here, "styles.css"), path.join(here, "manifest.json")];
  for (const file of files) await copyFile(file, path.join(target, path.basename(file)));
  console.log(`Installed into ${target}`);
}
