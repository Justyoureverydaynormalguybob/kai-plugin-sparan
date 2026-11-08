"use strict";
/*
 * Sparán for KAI — native service.
 *
 * A post-quantum Koinos wallet. The account is a koinos-pq "pqwallet" account: the koinos-pq
 * contract is installed on the address and every authority is locked to it, so only an
 * ML-DSA-44 (NIST FIPS 204) signature moves its KOIN. The rules live in koinos-pq-core,
 * bundled in vendor/pq-core.cjs.
 *
 * Keys:
 *   - One wallet per KAI profile. Its 32-byte seed (the 24 recovery words) is encrypted with
 *     the operating system's secret store through api.secrets and kept in the plugin's
 *     settings. Nothing in plain text is ever written. The plugin refuses to hold a key where
 *     the OS can't really encrypt (no encryption, or Linux's "basic_text" fallback).
 *   - The seed is decrypted only for the operation that needs it and wiped afterwards.
 *
 * Approvals: every action with an outside effect (sending, activating, showing the recovery
 * words, removing the wallet, a payment another plugin asks for) goes through
 * api.desktop.confirm, KAI's own attended approval. It returns false while KAI is hidden.
 * One approval at a time, and a short pause after a decline.
 *
 * Network: every request goes through api.network.fetch (see rpc.js), so KAI's Local-Only
 * setting stops the wallet from talking to Koinos.
 *
 * Other plugins: the "koinos.pq-wallet" service is refused until the user turns on
 * "Let other plugins use this wallet". Even then, a payment is approved by the user every
 * time, in a dialog that names the plugin that asked.
 */
const core = require("./vendor/pq-core.cjs");
const { makeChain, LocalOnlyError } = require("./rpc");
const { messages } = require("./messages");

const NETWORKS = ["mainnet", "testnet"];
const MODE = "pqwallet";
const DECLINE_COOLDOWN_MS = 3000;
const SERVICE = "koinos.pq-wallet";
const MAX_KNOWN = 200;
const HISTORY_MAX = 50;

function create(api) {
  if (api.version !== 1) throw Error("Sparán requires KAI Foundation API v1");
  let closed = false;
  let approving = false;
  let declinedAt = 0;
  let pending = null;     // a newly generated phrase waiting for the user to confirm it was written down
  let activation = null;  // { network, step, message, txId, error, done } while/after activating
  const chains = new Map();
  const sends = new Map(); // txId -> { network, status: "sent" | "mined" | "failed", block, error }

  const m = () => messages(api.locale.get().language);
  const alive = (signal) => {
    if (closed) throw Error("Sparán is closed");
    api.signal.throwIfAborted();
    signal?.throwIfAborted();
  };

  // ----- settings -----
  const network = () => (NETWORKS.includes(api.settings.get("network")) ? api.settings.get("network") : "mainnet");
  const chain = () => {
    const n = network();
    if (!chains.has(n)) chains.set(n, makeChain(core, api, n));
    return chains.get(n);
  };
  const shareWithPlugins = () => api.settings.get("shareWithPlugins", false) === true;
  const known = () => {
    const k = api.settings.get(`known.${network()}`, []);
    return Array.isArray(k) ? k.filter((a) => typeof a === "string") : [];
  };
  const remember = (address) => {
    const k = known().filter((a) => a !== address);
    k.unshift(address);
    api.settings.set(`known.${network()}`, k.slice(0, MAX_KNOWN));
  };

  // ----- the vault -----
  function secureStorage() {
    if (!api.secrets.isEncryptionAvailable()) return false;
    // Electron's Linux fallback "basic_text" encrypts with a key anyone can find.
    try { if (api.secrets.getSelectedStorageBackend?.() === "basic_text") return false; } catch { /* not reported */ }
    return true;
  }
  const vault = () => api.settings.get("vault", null);
  const hasWallet = () => !!(vault() && typeof vault().seed === "string");

  /** Run fn with the wallet's keys; the seed and secret key are wiped afterwards. */
  async function withKeys(fn) {
    const v = vault();
    if (!v || typeof v.seed !== "string") throw Error(m().noWallet);
    if (!secureStorage()) throw Error(m().noSecureStorage);
    const hex = api.secrets.decryptString(Buffer.from(v.seed, "base64"));
    const seed = Uint8Array.from(Buffer.from(hex, "hex"));
    if (seed.length !== 32) throw Error("the stored wallet is damaged");
    const keys = core.deriveKeys(seed);
    try {
      return await fn(keys);
    } finally {
      core.wipe(seed, keys.seed, keys.secretKey);
    }
  }

  function storeSeed(seed) {
    if (!secureStorage()) throw Error(m().noSecureStorage);
    const keys = core.deriveKeys(seed);
    const address = core.bootstrapAddress(keys);
    const sealed = Buffer.from(api.secrets.encryptString(Buffer.from(seed).toString("hex"))).toString("base64");
    api.settings.set("vault", { seed: sealed, address, createdAt: new Date().toISOString() });
    core.wipe(keys.seed, keys.secretKey);
    return address;
  }
  const address = () => (vault() ? vault().address : null);

  // ----- approvals -----
  async function approve(title, detail, signal) {
    if (approving) throw Error(m().approvalBusy);
    if (Date.now() - declinedAt < DECLINE_COOLDOWN_MS) throw Error(m().justDeclined);
    approving = true;
    try {
      const ok = await api.desktop.confirm(title, detail, signal);
      if (!ok) {
        declinedAt = Date.now();
        throw Object.assign(Error(m().notApproved), { code: "NOT_APPROVED" });
      }
    } finally {
      approving = false;
    }
  }

  // ----- reads -----
  const fmt = (base) => core.formatKoin(BigInt(base));

  async function balances(signal) {
    alive(signal);
    const a = address();
    if (!a) throw Error(m().noWallet);
    const c = chain();
    const [koin, mana] = await Promise.all([c.balance(a), c.mana(a)]);
    return { address: a, network: network(), koin: fmt(koin), koinBase: koin.toString(), mana: fmt(mana), manaBase: mana.toString() };
  }

  async function activationInfo(signal) {
    alive(signal);
    const a = address();
    if (!a) throw Error(m().noWallet);
    const c = chain();
    const [info, costs, mana] = await Promise.all([core.pqwalletInfo(c, a), core.estimateSetupCosts(c), c.mana(a)]);
    let keyMatches = null;
    if (info.deployed && info.keyRegistered) {
      const pk = await core.registeredPublicKey(c, a);
      keyMatches = await withKeys(async (keys) => !!pk && pk.length === keys.publicKey.length && pk.every((b, i) => b === keys.publicKey[i]));
    }
    return {
      deployed: info.deployed,
      keyRegistered: info.keyRegistered,
      active: info.deployed && info.keyRegistered && keyMatches === true,
      keyMatches,
      requiredMana: fmt(costs.requiredMana),
      mana: fmt(mana),
      enoughMana: mana >= costs.requiredMana,
    };
  }

  /** Is this a recipient the user has sent to before, or one that only looks like one? */
  function recipientCheck(to) {
    const list = known();
    if (list.includes(to)) return { known: true, lookalike: null };
    // Address poisoning: a planted address that shares the start and end of one you use.
    const lookalike = list.find((k) => k !== to && k.slice(0, 4) === to.slice(0, 4) && k.slice(-4) === to.slice(-4)) || null;
    return { known: false, lookalike };
  }

  function parseAmount(text) {
    try { return core.parseKoin(String(text)); } catch (e) { throw Error(m().badAmount); }
  }

  // ----- sending -----
  async function send({ to, amount, confirmNew, reason, caller }, signal) {
    alive(signal);
    if (api.network.status().privacyMode === "local-only") throw new LocalOnlyError();
    if (typeof to !== "string" || !core.isAddress(to)) throw Error(m().badAddress);
    to = to.trim();
    const value = parseAmount(amount);
    if (value <= 0n) throw Error(m().badAmount);
    const from = address();
    if (!from) throw Error(m().noWallet);
    if (to === from) throw Error(m().sendToSelf);

    const check = recipientCheck(to);
    // From the wallet's own window, a first-time recipient needs its last six characters
    // typed (the window sends them as confirmNew). Another plugin can't do that, so for it the
    // dialog itself says plainly that the address is new.
    if (!caller && !check.known && confirmNew !== to.slice(-6)) {
      throw Object.assign(Error(m().confirmNewRecipient), { code: "CONFIRM_NEW", lookalike: check.lookalike });
    }

    const c = chain();
    const [have, info] = await Promise.all([c.balance(from), core.pqwalletInfo(c, from)]);
    if (!info.deployed || !info.keyRegistered) throw Error(m().notActive);
    if (value > have) throw Error(m().notEnough(fmt(have)));

    const t = m();
    const lines = [
      t.dlgAmount(fmt(value)),
      t.dlgTo(to),
      t.dlgFrom(from),
      t.dlgNetwork(network()),
      check.known ? t.dlgKnown : t.dlgNew,
    ];
    if (check.lookalike) lines.push(t.dlgLookalike(check.lookalike));
    if (caller) lines.unshift(t.dlgCaller(caller), reason ? t.dlgReason(reason) : t.dlgNoReason, "");
    lines.push("", t.dlgFinal);
    await approve(caller ? t.dlgTitlePlugin(caller) : t.dlgTitleSend, lines.join("\n"), signal);

    const result = await withKeys((keys) => c.sendKoin({ from, to, valueBase: value, keys, mode: MODE }));
    remember(to);
    const net = network();
    sends.set(result.txId, { network: net, status: "sent" });
    // Watch for the block in the background; the window polls send.status.
    c.waitMined(result.txId, 180_000)
      .then((block) => sends.set(result.txId, { network: net, status: "mined", block }))
      .catch((e) => sends.set(result.txId, { network: net, status: "unconfirmed", error: String(e.message || e).slice(0, 200) }));
    return { txId: result.txId, network: net, explorer: explorer(net, result.txId) };
  }

  function explorer(net, txId) {
    const n = core.NETWORKS[net];
    return n && n.explorerTx ? n.explorerTx(txId) : null;
  }

  // ----- activation -----
  async function activate(signal) {
    alive(signal);
    if (activation && !activation.done) throw Error(m().activationRunning);
    const info = await activationInfo(signal);
    if (info.active) return { alreadyActive: true };
    if (info.deployed && info.keyRegistered && info.keyMatches === false) throw Error(m().otherKey);
    if (!info.enoughMana) throw Error(m().needMana(info.requiredMana, info.mana));
    const t = m();
    await approve(t.actTitle, [t.actDetail(address(), network(), info.requiredMana), "", t.actFinal].join("\n"), signal);
    const net = network();
    activation = { network: net, step: "checking", message: t.actStarting, txId: null, error: null, done: false };
    const c = chain();
    // Not awaited: activation can take minutes while the network releases a mana hold.
    withKeys((keys) => core.setupPqwalletAccount(c, keys, (s) => { activation = { ...activation, step: s.step, message: s.message, txId: s.txId || activation.txId }; }))
      .then(() => { activation = { ...activation, step: "done", done: true }; })
      .catch((e) => { activation = { ...activation, done: true, error: String(e.message || e).slice(0, 300) }; });
    return { started: true };
  }

  // ----- the window's methods -----
  async function state() {
    const privacyMode = api.network.status().privacyMode;
    return {
      hasWallet: hasWallet(),
      address: address(),
      network: network(),
      networks: NETWORKS,
      secureStorage: secureStorage(),
      privacyMode,
      localOnly: privacyMode === "local-only",
      shareWithPlugins: shareWithPlugins(),
      activation,
      pqwalletWasmSha256: core.PQWALLET_WASM_SHA256,
    };
  }

  const handlers = {
    "state": () => state(),

    // A new phrase is generated here and kept in memory until the window confirms it was written down.
    "wallet.generate": async () => {
      if (hasWallet()) throw Error(m().alreadyHaveWallet);
      if (!secureStorage()) throw Error(m().noSecureStorage);
      pending = core.newMnemonic();
      return { words: pending.split(" ") };
    },
    "wallet.confirmGenerated": async (input) => {
      if (!pending) throw Error(m().nothingPending);
      const words = pending.split(" ");
      const checks = Array.isArray(input && input.checks) ? input.checks : [];
      if (checks.length < 3 || !checks.every((c) => Number.isInteger(c.index) && words[c.index] === String(c.word || "").trim().toLowerCase())) {
        throw Error(m().wordsDontMatch);
      }
      const seed = core.mnemonicToSeed(pending);
      pending = null;
      try { return { address: storeSeed(seed) }; } finally { core.wipe(seed); }
    },
    "wallet.restore": async (input, signal) => {
      const phrase = core.normalizeMnemonic(String((input && input.words) || ""));
      if (!core.isMnemonic(phrase)) throw Error(m().badPhrase);
      if (hasWallet()) await approve(m().replaceTitle, m().replaceDetail(address()), signal);
      const seed = core.mnemonicToSeed(phrase);
      try { return { address: storeSeed(seed) }; } finally { core.wipe(seed); }
    },
    "wallet.reveal": async (_input, signal) => {
      await approve(m().revealTitle, m().revealDetail, signal);
      return withKeys(async (keys) => ({ words: core.seedToMnemonic(keys.seed).split(" ") }));
    },
    "wallet.remove": async (_input, signal) => {
      if (!hasWallet()) return { removed: false };
      await approve(m().removeTitle, m().removeDetail(address()), signal);
      api.settings.set("vault", null);
      activation = null;
      return { removed: true };
    },

    "network.set": async (input) => {
      const n = input && input.network;
      if (!NETWORKS.includes(n)) throw Error("unknown network");
      api.settings.set("network", n);
      activation = null;
      return { network: n };
    },
    "share.set": async (input, signal) => {
      const on = !!(input && input.on);
      if (on) await approve(m().shareTitle, m().shareDetail, signal);
      api.settings.set("shareWithPlugins", on);
      return { shareWithPlugins: on };
    },

    "balances": (_i, signal) => balances(signal),
    "activation.info": (_i, signal) => activationInfo(signal),
    "activation.start": (_i, signal) => activate(signal),
    "history": async (input, signal) => {
      alive(signal);
      const a = address();
      if (!a) throw Error(m().noWallet);
      const limit = Math.min(Math.max(Number(input && input.limit) || 20, 1), HISTORY_MAX);
      const items = await chain().history(a, limit);
      return { items: items.map((it) => ({ ...it, amount: it.valueBase ? fmt(it.valueBase) : null, isKoin: it.contract === core.NETWORKS[network()].koin, explorer: it.txId ? explorer(network(), it.txId) : null })) };
    },
    "recipient.check": async (input) => {
      const to = String((input && input.to) || "").trim();
      if (!core.isAddress(to)) return { valid: false };
      return { valid: true, ...recipientCheck(to), self: to === address() };
    },
    "send": (input, signal) => send({ to: input && input.to, amount: input && input.amount, confirmNew: input && input.confirmNew }, signal),
    "send.status": async (input) => sends.get(String((input && input.txId) || "")) || null,
    // Opens a transaction or the wallet's address on the explorer. The URL is built here from a
    // checked id, never taken from the window, and KAI reviews it before opening.
    "explorer.open": async (input) => {
      const txId = String((input && input.txId) || "");
      const n = core.NETWORKS[network()];
      if (/^0x1220[0-9a-f]{64}$/.test(txId) && n.explorerTx) return api.desktop.openExternal(n.explorerTx(txId));
      if (input && input.address === true && address()) {
        const base = network() === "mainnet" ? "https://koinosblocks.com" : "https://harbinger.koinosblocks.com";
        return api.desktop.openExternal(`${base}/address/${address()}`);
      }
      throw Error("nothing to open");
    },
  };

  // ----- the service other plugins can call -----
  let removeProvider = () => {};
  try {
    removeProvider = api.services.provide(SERVICE, {
      methods: ["status", "balance", "requestPayment"],
      async call(method, input, context) {
        context.signal.throwIfAborted();
        if (context.remote) throw Error("Sparán serves local plugins only");
        if (!shareWithPlugins()) throw Error("Sparán: the user hasn't allowed other plugins to use this wallet. Ask them to turn it on in Sparán.");
        if (!hasWallet()) throw Error("Sparán has no wallet yet");
        if (method === "status") return { address: address(), network: network() };
        if (method === "balance") {
          const b = await balances(context.signal);
          return { address: b.address, network: b.network, koin: b.koin, mana: b.mana };
        }
        if (method === "requestPayment") {
          const caller = String(context.caller || "an unnamed plugin").slice(0, 100);
          const reason = typeof (input && input.reason) === "string" ? input.reason.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").slice(0, 200) : "";
          return send({ to: input && input.to, amount: input && input.amount, reason, caller }, context.signal);
        }
        throw Error(`unknown method ${method}`);
      },
    });
  } catch (e) {
    // Another enabled plugin may already provide the name; the wallet still works on its own.
    api.log("warn", `could not provide ${SERVICE}: ${e.message}`);
  }

  function dispose() {
    if (closed) return;
    closed = true;
    pending = null;
    try { removeProvider(); } catch { /* already gone */ }
    api.signal.removeEventListener("abort", dispose);
  }
  api.signal.addEventListener("abort", dispose, { once: true });

  return {
    async call(method, input, signal) {
      alive(signal);
      const h = Object.hasOwn(handlers, method) ? handlers[method] : null;
      if (!h) throw Error(`unknown method ${method}`);
      try {
        return await h(input || {}, signal);
      } catch (e) {
        if (e instanceof LocalOnlyError) throw Error(m().localOnly);
        throw e;
      }
    },
    windowClosed() { pending = null; }, // a phrase nobody confirmed is dropped, never stored
    dispose,
  };
}

module.exports = { create };
