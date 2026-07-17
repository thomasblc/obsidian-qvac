import esbuild from "esbuild";
import process from "process";
import { readFileSync } from "fs";
import { builtinModules } from "module";

const prod = process.argv[2] === "production";
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Stamp the version into main.js so each release has a distinct build (and a distinct hash).
  banner: { js: `/* QVAC Local AI v${version} */` },
  // Obsidian + Electron + Node builtins are provided by the host at runtime, never bundled.
  external: [
    "obsidian", "electron",
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
    "@codemirror/language", "@codemirror/lint", "@codemirror/search",
    "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
    ...builtinModules, ...builtinModules.map((m) => "node:" + m),
  ],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) { await ctx.rebuild(); await ctx.dispose(); }
else { await ctx.watch(); }
