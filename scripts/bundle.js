"use strict";
// Builds plugin/service/vendor/pq-core.cjs from src/core-entry.mjs, plus the licences of
// everything inside it. Run after `npm ci`; the output is committed so the package can be
// rebuilt and checked byte for byte.
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const vendor = path.join(root, "plugin", "service", "vendor");
fs.mkdirSync(vendor, { recursive: true });

(async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(root, "src", "core-entry.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: path.join(vendor, "pq-core.cjs"),
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
    // koilib imports cross-fetch (node-fetch underneath). The plugin never lets koilib fetch on
    // its own: service/chain.js routes every RPC call through KAI's network broker, which
    // honours Local-Only. So cross-fetch becomes a stub that refuses, rather than dead code.
    plugins: [{
      name: "no-cross-fetch",
      setup(build) {
        build.onResolve({ filter: /^cross-fetch$/ }, () => ({ path: "cross-fetch", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: [
            "function refuse() { return Promise.reject(new Error('direct network access is disabled; requests go through KAI')); }",
            "module.exports = refuse; module.exports.default = refuse; module.exports.fetch = refuse;",
          ].join("\n"),
          loader: "js",
        }));
      },
    }],
  });

  // Licence of every package that ended up in the bundle.
  const pkgs = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
    if (!m) continue;
    const dir = path.join(root, input.slice(0, m.index + m[0].length));
    if (pkgs.has(dir)) continue;
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const lic = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    pkgs.set(dir, { name: pj.name, version: pj.version, license: pj.license, text: lic ? fs.readFileSync(path.join(dir, lic), "utf8") : null });
  }
  const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = ["Third-party code bundled in pq-core.cjs", "========================================", ""];
  for (const p of list) {
    out.push(`${p.name} ${p.version} (${p.license})`, "-".repeat(60), p.text ? p.text.trim() : `(no licence file shipped; package.json says ${p.license})`, "", "");
  }
  fs.writeFileSync(path.join(vendor, "THIRD-PARTY-LICENSES.txt"), out.join("\n"));
  const size = fs.statSync(path.join(vendor, "pq-core.cjs")).size;
  console.log(`pq-core.cjs ${(size / 1024).toFixed(0)} KB, ${list.length} packages: ${list.map((p) => p.name).join(", ")}`);
})().catch((e) => { console.error(e); process.exit(1); });
