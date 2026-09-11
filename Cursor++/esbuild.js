const esbuild = require("esbuild");
const { cpSync, mkdirSync, readdirSync } = require("fs");
const { join } = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// HUB_URL —— 字符串在 js-confuser 的 StringConcealing 下不可见
const HUB_URL = "https://ccursor.cometix.dev";

function copyRuntimeAssets() {
  mkdirSync(join(__dirname, "dist"), { recursive: true });

  // Copy supermarkdown NAPI .node binaries + JS entry to dist/
  const smDir = join(__dirname, "node_modules", "@vakra-dev", "supermarkdown");
  try {
    for (const f of readdirSync(smDir)) {
      if (f.endsWith(".node") || f === "index.js" || f === "index.d.ts") {
        cpSync(join(smDir, f), join(__dirname, "dist", f));
      }
    }
    console.log("[build] supermarkdown native binaries copied to dist/");
  } catch (e) {
    console.warn("[build] supermarkdown copy failed:", e.message);
  }

  // Copy gpt-tokenizer o200k_base encoding to dist/ (external, not obfuscated)
  try {
    cpSync(
      join(__dirname, "node_modules", "gpt-tokenizer", "dist", "o200k_base.js"),
      join(__dirname, "dist", "o200k_base.js"),
    );
    console.log("[build] gpt-tokenizer o200k_base copied to dist/");
  } catch (e) {
    console.warn("[build] gpt-tokenizer copy failed:", e.message);
  }
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`,
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  // ── Context 1: Extension host (Node.js) ──
  const extCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outdir: "dist",
    external: ["vscode"],
    logLevel: "silent",
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
    define: {
      "import.meta.url": "undefined",
      __HUB_URL__: JSON.stringify(HUB_URL),
    },
    plugins: [
      {
        name: "supermarkdown-native",
        setup(build) {
          build.onResolve({ filter: /^@vakra-dev\/supermarkdown$/ }, () => ({
            path: "./index.js",
            external: true,
          }));
        },
      },
      {
        name: "gpt-tokenizer-external",
        setup(build) {
          build.onResolve({ filter: /^gpt-tokenizer\/encoding\/o200k_base$/ }, () => ({
            path: "./o200k_base.js",
            external: true,
          }));
        },
      },
      esbuildProblemMatcherPlugin,
    ],
  });

  // ── Context 2: Webview (Browser, IIFE) ──
  const webCtx = await esbuild.context({
    entryPoints: ["src/ui/webview/alpine-entry.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: false,
    platform: "browser",
    outfile: "dist/webview.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  // ── Context 3: Usage Dashboard (Browser, IIFE) ──
  // 独立入口 — 只被 Dashboard panel 加载, 不影响侧栏 webview.js 体积
  const dashCtx = await esbuild.context({
    entryPoints: ["src/ui/dashboard/entry.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: false,
    platform: "browser",
    outfile: "dist/dashboard.js",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    copyRuntimeAssets();
    await Promise.all([extCtx.watch(), webCtx.watch(), dashCtx.watch()]);
  } else {
    await Promise.all([
      extCtx.rebuild(),
      webCtx.rebuild(),
      dashCtx.rebuild(),
    ]);
    await Promise.all([extCtx.dispose(), webCtx.dispose(), dashCtx.dispose()]);
    copyRuntimeAssets();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
