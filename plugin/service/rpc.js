"use strict";
// Koinos JSON-RPC through KAI's network broker.
//
// koinos-pq-core's Chain uses koilib's Provider, which would call fetch() itself. Inside KAI a
// plugin must not reach the network on its own: api.network.fetch is public-HTTPS only, checks
// DNS, refuses redirects and is switched off by Local-Only. So each Chain's provider.call is
// replaced with one that goes through the broker, and the bundled cross-fetch is a stub that
// refuses (scripts/bundle.js), so nothing can bypass this by accident.
//
// Errors keep koilib's shape (a JSON string of {error, ...data}) because koinos-pq-core matches
// on their text, e.g. "insufficient pending account resources" while a mana hold clears.

// api.koinos.io intermittently answers "AMQP connection is not open"; koinosblocks.com serves
// the same chain. Checked from KoinosProof on Railway, 2026-11-04.
const RPC = {
  mainnet: ["https://api.koinos.io/jsonrpc", "https://api.koinosblocks.com/jsonrpc"],
  testnet: ["https://testnet.koinosfoundation.org/jsonrpc"],
};

const NODE_TROUBLE = /AMQP|internal server error|bad gateway|service unavailable|gateway time-?out|ECONN|ETIMEDOUT|socket hang up|fetch failed|not valid JSON|Unexpected token/i;

class LocalOnlyError extends Error {
  constructor() {
    super("KAI is set to Local-Only, so Sparán can't reach the Koinos network. Change privacy in KAI to use the wallet.");
    this.code = "LOCAL_ONLY";
  }
}

function makeRpc(api, nodes, { timeoutMs = 30_000 } = {}) {
  let current = 0;
  let id = 0;

  async function once(url, method, params, signal) {
    const timer = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timer, api.signal]) : AbortSignal.any([timer, api.signal]);
    const res = await api.network.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: combined,
    });
    const text = await res.text(); // always consume the body so KAI's request tracking can finish
    if (!res.ok && !text.trim().startsWith("{")) throw new Error(`node answered HTTP ${res.status}`);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`node sent a reply that is not valid JSON (HTTP ${res.status})`); }
    if (json.result !== undefined) return json.result;
    if (!json.error) throw new Error("undefined error");
    const { message, data } = json.error;
    if (!data) throw new Error(message);
    let extra;
    try { extra = JSON.parse(data); } catch { extra = { data }; }
    throw new Error(JSON.stringify({ ...(message && { error: message }), ...extra }));
  }

  return async function call(method, params, signal) {
    if (api.network.status().privacyMode === "local-only") throw new LocalOnlyError();
    let last;
    for (let i = 0; i < nodes.length; i++) {
      const at = (current + i) % nodes.length;
      try {
        const result = await once(nodes[at], method, params, signal);
        current = at;
        return result;
      } catch (e) {
        last = e;
        if (signal?.aborted || api.signal.aborted) throw e;
        // A real answer from the chain (a refused transaction, a missing contract) is the same
        // on every node; only trouble with the node itself moves on to the next one.
        if (!NODE_TROUBLE.test(String(e && e.message))) throw e;
        api.log("warn", `Koinos node ${new URL(nodes[at]).host} failed (${String(e.message).slice(0, 80)}); trying the next one`);
      }
    }
    throw last;
  };
}

/** A koinos-pq-core Chain for `network` whose every request goes through api.network.fetch. */
function makeChain(core, api, network) {
  const net = core.NETWORKS[network];
  if (!net || !RPC[network]) throw new Error(`unknown network ${network}`);
  const nodes = RPC[network];
  const chain = new core.Chain({ ...net, rpc: nodes });
  const call = makeRpc(api, nodes);
  chain.provider.call = (method, params) => call(method, params);
  return chain;
}

module.exports = { makeChain, makeRpc, LocalOnlyError, RPC };
