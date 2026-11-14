// Bundles the plugin (and the shared src/core) into obsidian-plugin/main.js.
// `node obsidian-plugin/esbuild.config.mjs --install /path/to/vault` also copies it into
// <vault>/.obsidian/plugins/yorum/ so Obsidian can load it.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

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
  sourcemap: "inline",
});

const installAt = process.argv.indexOf("--install");
if (installAt !== -1) {
  const vault = process.argv[installAt + 1];
  if (!vault) throw new Error("--install needs a vault folder");
  const target = path.join(path.resolve(vault), ".obsidian", "plugins", "yorum");
  await mkdir(target, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(path.join(here, file), path.join(target, file));
  }
  console.log(`Installed into ${target}`);
}
