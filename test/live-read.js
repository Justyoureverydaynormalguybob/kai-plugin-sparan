"use strict";
// Read-only check against the real Koinos networks (not part of npm test: it needs the internet).
//   node test/live-read.js [address ...]
// Uses the same rpc.js path as the plugin, with KAI's broker replaced by the real fetch.
const core = require("../plugin/service/vendor/pq-core.cjs");
const { makeChain } = require("../plugin/service/rpc");

const api = {
  signal: new AbortController().signal,
  network: { status: () => ({ privacyMode: "network" }), fetch: (url, opts) => fetch(url, { ...opts, redirect: "error" }) },
  log: (level, msg) => console.log(`  [${level}] ${msg}`),
};

(async () => {
  const addrs = process.argv.slice(2);
  const targets = addrs.length ? addrs.map((a) => ["mainnet", a]) : [
    ["mainnet", "14gWa9ngVcfRddjE43HRhjfY6tB6QzKGfz"], // KoinosProof's payer: an ordinary account
    ["mainnet", "1F3khauD9dgHB7sopYPYHZML31fuSxw9hN"], // KoinosProof's post-quantum owner: a pqwallet account
    ["testnet", "1LQYsdpGuA3nwU5G1jANCnMWs3yYWfHwkQ"], // koinos-pq-core's Harbinger test account
  ];
  for (const [net, a] of targets) {
    const c = makeChain(core, api, net);
    const [koin, mana, info, head] = await Promise.all([c.balance(a), c.mana(a), core.pqwalletInfo(c, a), c.headHeight()]);
    const costs = await core.estimateSetupCosts(c);
    const hist = await c.history(a, 3).catch((e) => `history failed: ${e.message}`);
    console.log(`${net} ${a}: ${core.formatKoin(koin)} KOIN, mana ${core.formatKoin(mana)}, pqwallet ${info.deployed ? "installed" : "no"}${info.keyRegistered ? " + key registered" : ""}; head ${head}; activation needs ~${core.formatKoin(costs.requiredMana)} KOIN of mana; history ${Array.isArray(hist) ? hist.length + " items" : hist}`);
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
