// Bundles the plugin (and the shared src/core) into obsidian-plugin/main.js.
// `--production` (release builds) leaves out the inline source map.
// `--install /path/to/vault` also copies main.js, styles.css and the repo-root manifest.json into
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
  // Provided by Obsidian at runtime.
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
  logLevel: "info",
  sourcemap: production ? false : "inline",
});

const installAt = process.argv.indexOf("--install");
if (installAt !== -1) {
  const vault = process.argv[installAt + 1];
  if (!vault) throw new Error("--install needs a vault folder");
  const target = path.join(path.resolve(vault), ".obsidian", "plugins", "yorum");
  await mkdir(target, { recursive: true });
  const files = [path.join(here, "main.js"), path.join(here, "styles.css"), path.join(here, "..", "manifest.json")];
  for (const file of files) await copyFile(file, path.join(target, path.basename(file)));
  console.log(`Installed into ${target}`);
}
