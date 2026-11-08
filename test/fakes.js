"use strict";
// A fake KAI Foundation API v1 (kai-core docs/foundation/api-v1.d.ts) and a fake Koinos JSON-RPC
// node, enough to run Sparán's real service outside Electron. The node answers in the chain's
// own wire formats (protobuf fields, base64url, base58), so a send really builds, signs and
// submits a transaction, and the tests can check the ML-DSA-44 signature on it.
const core = require("../plugin/service/vendor/pq-core.cjs");
const { koilibUtils: U } = core;

const ENTRY = { balance_of: 0x5c721497, transfer: 0x27f576ca, get_info: 0xbd7f6850, get_public_key: 0x96634f68 };
const KOIN = { mainnet: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", testnet: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju" };

// ----- tiny protobuf -----
function varint(n) {
  let v = BigInt(n);
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}
const fVarint = (field, v) => [...varint((field << 3) | 0), ...varint(v)];
const fBytes = (field, bytes) => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
const b64 = (arr) => U.encodeBase64url(Uint8Array.from(arr));
function fields(bytes) {
  const out = new Map();
  let i = 0;
  const rd = () => { let v = 0n, s = 0n; for (;;) { const c = bytes[i++]; v |= BigInt(c & 0x7f) << s; s += 7n; if (c < 0x80) return v; } };
  while (i < bytes.length) {
    const tag = rd(); const f = Number(tag >> 3n), w = Number(tag & 7n);
    let v;
    if (w === 0) v = rd();
    else if (w === 2) { const len = Number(rd()); v = bytes.slice(i, i + len); i += len; }
    else throw Error("wire type " + w);
    if (!out.has(f)) out.set(f, []);
    out.get(f).push(v);
  }
  return out;
}

function createFakeNode({ network = "mainnet" } = {}) {
  const state = {
    balances: new Map(), rc: new Map(), nonces: new Map(), contracts: new Map(), // address -> { publicKey }
    submitted: [], calls: [], failNext: [], // failNext: [{ method?, error }] node trouble to inject
    prices: { disk_storage_cost: "1", network_bandwidth_cost: "1", compute_bandwidth_cost: "1" },
  };
  const koin = KOIN[network];

  function rpcError(message, data) { return { error: { code: -32603, message, ...(data ? { data } : {}) } }; }

  function handle(url, body) {
    const { method, params, id } = body;
    state.calls.push({ url, method });
    const inject = state.failNext.length && (!state.failNext[0].method || state.failNext[0].method === method) ? state.failNext.shift() : null;
    if (inject) return { jsonrpc: "2.0", id, ...rpcError("An internal server error has occurred", inject.error) };
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "chain.get_account_rc": return ok({ rc: String(state.rc.get(params.account) || 0n) });
      case "chain.get_resource_limits": return ok({ resource_limit_data: state.prices });
      case "chain.get_account_nonce": return ok({ nonce: b64([0x28, ...varint(state.nonces.get(params.account) || 0)]) });
      case "chain.get_chain_id": return ok({ chain_id: U.encodeBase64url(Uint8Array.from([0x12, 0x20, ...new Array(32).fill(7)])) });
      case "account_history.get_account_history": return ok({ values: [] });
      case "chain.read_contract": {
        const args = U.decodeBase64url(params.args || "");
        if (params.contract_id === koin && params.entry_point === ENTRY.balance_of) {
          const owner = U.encodeBase58(fields(args).get(1)[0]);
          const bal = state.balances.get(owner) || 0n;
          return ok(bal ? { result: b64(fVarint(1, bal)) } : {});
        }
        const c = state.contracts.get(params.contract_id);
        if (!c) return { jsonrpc: "2.0", id, ...rpcError("contract does not exist") };
        if (params.entry_point === ENTRY.get_info) {
          return ok({ result: b64([...fBytes(1, [...Buffer.from("ML-DSA-44")]), ...fVarint(2, 1312), ...fVarint(3, 2420), ...fVarint(5, c.publicKey ? 1 : 0)]) });
        }
        if (params.entry_point === ENTRY.get_public_key) return ok(c.publicKey ? { result: b64(fBytes(1, [...c.publicKey])) } : {});
        return { jsonrpc: "2.0", id, ...rpcError("unknown entry point") };
      }
      case "chain.submit_transaction": {
        const tx = params.transaction;
        state.submitted.push(tx);
        // Apply what the chain would: a KOIN transfer moves balances; an upload installs a
        // contract; set_public_key on an installed pqwallet registers the key.
        for (const op of tx.operations || []) {
          if (op.upload_contract) {
            state.contracts.set(op.upload_contract.contract_id, { publicKey: null, uploadedBy: tx.header.payer, bytes: U.decodeBase64url(op.upload_contract.bytecode).length });
            continue;
          }
          const cc = op.call_contract;
          if (cc && cc.entry_point === 0x4cc6c61b && state.contracts.has(cc.contract_id)) {
            state.contracts.get(cc.contract_id).publicKey = fields(U.decodeBase64url(cc.args)).get(1)[0];
            continue;
          }
          if (cc && cc.contract_id === koin && cc.entry_point === ENTRY.transfer) {
            const f = fields(U.decodeBase64url(cc.args));
            const from = U.encodeBase58(f.get(1)[0]), to = U.encodeBase58(f.get(2)[0]), value = f.get(3)[0];
            state.balances.set(from, (state.balances.get(from) || 0n) - value);
            state.balances.set(to, (state.balances.get(to) || 0n) + value);
          }
        }
        state.nonces.set(tx.header.payer, (state.nonces.get(tx.header.payer) || 0) + 1);
        return ok({ receipt: { id: tx.id, payer: tx.header.payer, rc_used: "1000", reverted: false, events: [] } });
      }
      default:
        return { jsonrpc: "2.0", id, ...rpcError(`fake node: no ${method}`) };
    }
  }

  return { state, handle, koin, decodeTransfer: (args) => { const f = fields(U.decodeBase64url(args)); return { from: U.encodeBase58(f.get(1)[0]), to: U.encodeBase58(f.get(2)[0]), value: f.get(3)[0] }; } };
}

function createFakeApi({ encryption = true, backend = "dpapi", approve = true, privacyMode = "network", node = createFakeNode(), language = "en", caller } = {}) {
  const controller = new AbortController();
  const store = new Map();
  const calls = { confirms: [], fetches: [], opened: [], logs: [] };
  const providers = new Map();
  let mode = privacyMode;
  const api = {
    version: 1,
    plugin: Object.freeze({ id: "community.sparan", version: "0.1.0", root: "/fake/root", dataDir: "/fake/data" }),
    paths: { protected: ["/fake/profile"] },
    signal: controller.signal,
    settings: {
      get: (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: (key, value) => { store.set(key, structuredClone(value)); return value; },
    },
    locale: { get: () => ({ language, direction: "ltr", selected: true, languages: [] }), onChange: () => () => {} },
    network: {
      status: () => ({ privacyMode: mode }),
      configure: async () => { throw Error("not used"); },
      models: async () => [],
      fetch: async (url, opts) => {
        calls.fetches.push(url);
        if (mode === "local-only") throw Error("Local-Only blocks network requests");
        if (!/^https:\/\//.test(url)) throw Error("public HTTPS only");
        const out = node.handle(url, JSON.parse(opts.body));
        return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
    secrets: {
      isEncryptionAvailable: () => encryption,
      getSelectedStorageBackend: () => backend,
      // Reversible but not plain: the tests check the plain seed never reaches settings.
      encryptString: (s) => Buffer.from("ENC:" + Buffer.from(s, "utf8").reverse().toString("base64")),
      decryptString: (b) => { const s = Buffer.from(b).toString("utf8"); if (!s.startsWith("ENC:")) throw Error("not ours"); return Buffer.from(s.slice(4), "base64").reverse().toString("utf8"); },
    },
    desktop: {
      isVisible: () => true,
      confirm: async (title, detail) => { calls.confirms.push({ title, detail }); return typeof approve === "function" ? approve(title, detail) : approve; },
      openExternal: async (url) => { calls.opened.push(url); return { opened: true }; },
    },
    services: {
      provide: (name, def) => { providers.set(name, def); return () => providers.delete(name); },
      call: async () => { throw Error("not used"); },
    },
    log: (level, message) => calls.logs.push({ level, message: String(message) }),
  };
  return {
    api, store, calls, node, providers,
    setPrivacy: (m) => { mode = m; },
    setApprove: (a) => { approve = a; },
    abort: () => controller.abort(),
    /** Call the provided koinos.pq-wallet service as another plugin would. */
    asPlugin: (method, input, pluginId = caller || "community.shop") =>
      providers.get("koinos.pq-wallet").call(method, input, { caller: pluginId, remote: false, signal: new AbortController().signal }),
  };
}

module.exports = { createFakeApi, createFakeNode, KOIN };
