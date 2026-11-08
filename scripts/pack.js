"use strict";
// Signs plugin/ into dist/kai-plugin-sparan-<version>.kaiplugin with KAI Core's own packer, then
// verifies it with Core's own verifier, so the package format is never re-implemented here.
//
//   node scripts/pack.js --core <path to a kai-core checkout> --key <ed25519 private key .pem>
//
// Refuses a key stored inside this repository, refuses to pack uncommitted plugin files or a
// bundle that doesn't match the pinned koinos-pq-core build, and never overwrites a release.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const core = arg("core") || process.env.KAI_CORE_DIR;
const key = arg("key") || process.env.KAI_PLUGIN_KEY;
if (!core || !key) {
  console.error("Usage: node scripts/pack.js --core <kai-core checkout> --key <ed25519 private key .pem>");
  process.exit(2);
}
const root = fs.realpathSync(path.resolve(__dirname, ".."));
const keyReal = fs.realpathSync(path.resolve(key));
const norm = (p) => (process.platform === "linux" ? p : p.toLowerCase());
if (norm(keyReal).startsWith(norm(root + path.sep))) throw Error("Refusing to use a signing key stored inside this repository");

// The committed bundle must be exactly what scripts/bundle.js builds from the lockfile.
const bundle = path.join(root, "plugin", "service", "vendor", "pq-core.cjs");
const before = fs.readFileSync(bundle);
execFileSync(process.execPath, [path.join(root, "scripts", "bundle.js")], { stdio: "inherit" });
if (!before.equals(fs.readFileSync(bundle))) throw Error("plugin/service/vendor/pq-core.cjs was not the build of the locked koinos-pq-core; commit the rebuilt bundle first");

const dirty = execFileSync("git", ["status", "--porcelain", "--", "plugin"], { cwd: root, encoding: "utf8" }).trim();
if (dirty) throw Error(`plugin/ has uncommitted or untracked changes; commit them before packing:\n${dirty}`);

const source = path.join(root, "plugin");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
const out = path.join(root, "dist", `kai-plugin-sparan-${manifest.version}.kaiplugin`);
if (fs.existsSync(out)) throw Error(`${path.relative(root, out)} already exists; bump the version instead of re-signing a release`);
fs.mkdirSync(path.dirname(out), { recursive: true });

execFileSync(process.execPath, [path.join(core, "scripts/core/pack-plugin.js"), source, keyReal, out], { stdio: "inherit" });

const { verifyPackage } = require(path.join(path.resolve(core), "core/lib/plugins/package"));
const bytes = fs.readFileSync(out);
const verified = verifyPackage(bytes.toString("utf8"));
console.log(JSON.stringify({
  file: path.relative(root, out),
  id: verified.manifest.id,
  version: verified.manifest.version,
  fingerprint: verified.fingerprint,
  digest: verified.digest,
  fileSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
}, null, 2));
