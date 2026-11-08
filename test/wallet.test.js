"use strict";
// Sparán's native service end to end against a fake KAI API and a fake Koinos node.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../plugin/service/vendor/pq-core.cjs");
const { create } = require("../plugin/service/index.js");
const { catalogs: serviceCatalogs } = require("../plugin/service/messages.js");
const { createFakeApi, createFakeNode } = require("./fakes");

// Mining is watched in the background; the fake node has no blocks, so finish at once.
core.Chain.prototype.waitMined = async () => "12345";

const RECIPIENT = "1BRmrUgtSQVUggoeE9weG4f7nidyydnYfQ";
const ONE = 100000000n;

async function newWallet(fake) {
  const svc = await create(fake.api);
  const { words } = await svc.call("wallet.generate", {});
  const checks = [0, 11, 23].map((index) => ({ index, word: words[index] }));
  const { address } = await svc.call("wallet.confirmGenerated", { checks });
  return { svc, words, address };
}
const keysOf = (words) => core.deriveKeys(core.mnemonicToSeed(words.join(" ")));
function activateOnChain(fake, address, words, { koin = 100n * ONE, rc = 100n * ONE } = {}) {
  fake.node.state.balances.set(address, koin);
  fake.node.state.rc.set(address, rc);
  fake.node.state.contracts.set(address, { publicKey: keysOf(words).publicKey });
}

test("won't hold a key without real OS encryption", async () => {
  for (const opts of [{ encryption: false }, { backend: "basic_text" }]) {
    const fake = createFakeApi(opts);
    const svc = await create(fake.api);
    assert.equal((await svc.call("state", {})).secureStorage, false);
    await assert.rejects(svc.call("wallet.generate", {}), /can't encrypt/);
    await assert.rejects(svc.call("wallet.restore", { words: core.newMnemonic() }), /can't encrypt/);
  }
});

test("a new wallet is saved only after the words are confirmed, and never in plain text", async () => {
  const fake = createFakeApi();
  const svc = await create(fake.api);
  const { words } = await svc.call("wallet.generate", {});
  assert.equal(words.length, 24);
  assert.equal((await svc.call("state", {})).hasWallet, false, "nothing stored before confirming");
  await assert.rejects(svc.call("wallet.confirmGenerated", { checks: [{ index: 0, word: "wrong" }, { index: 1, word: words[1] }, { index: 2, word: words[2] }] }), /don't match/);
  await assert.rejects(svc.call("wallet.confirmGenerated", { checks: [{ index: 0, word: words[0] }] }), /don't match/, "three words needed");
  const { address } = await svc.call("wallet.confirmGenerated", { checks: [3, 9, 20].map((index) => ({ index, word: words[index].toUpperCase() + " " })) });
  assert.equal(address, core.bootstrapAddress(keysOf(words)));
  const st = await svc.call("state", {});
  assert.equal(st.hasWallet, true);
  assert.equal(st.address, address);

  const stored = JSON.stringify([...fake.store.entries()]);
  const seedHex = Buffer.from(core.mnemonicToSeed(words.join(" "))).toString("hex");
  assert.ok(!stored.includes(seedHex), "the seed is not stored in plain hex");
  assert.ok(!words.some((w) => stored.includes(`"${w}"`) || stored.includes(` ${w} `)), "no recovery word is stored");
  await assert.rejects(svc.call("wallet.confirmGenerated", { checks: [] }), /no new phrase/, "the phrase is dropped after saving");
  await assert.rejects(svc.call("wallet.generate", {}), /already has a wallet/);
});

test("closing the window drops a phrase nobody confirmed", async () => {
  const fake = createFakeApi();
  const svc = await create(fake.api);
  const { words } = await svc.call("wallet.generate", {});
  svc.windowClosed();
  await assert.rejects(svc.call("wallet.confirmGenerated", { checks: [0, 1, 2].map((index) => ({ index, word: words[index] })) }), /no new phrase/);
});

test("restore, reveal and remove each need approval", async () => {
  const fake = createFakeApi();
  const svc = await create(fake.api);
  const phrase = core.newMnemonic();
  await assert.rejects(svc.call("wallet.restore", { words: "not a phrase" }), /valid 24-word/);
  const { address } = await svc.call("wallet.restore", { words: "  " + phrase.toUpperCase().replace(/ /g, "   ") + "\n" });
  assert.equal(address, core.bootstrapAddress(core.deriveKeys(core.mnemonicToSeed(phrase))));
  assert.equal(fake.calls.confirms.length, 0, "a first restore needs no approval");

  fake.setApprove(false);
  await assert.rejects(svc.call("wallet.reveal", {}), /Not approved/);
  await new Promise((r) => setTimeout(r, 3100)); // the pause after a decline
  fake.setApprove(true);
  const { words } = await svc.call("wallet.reveal", {});
  assert.equal(words.join(" "), phrase);
  assert.match(fake.calls.confirms.at(-1).detail, /24 words can take everything/);

  // Replacing needs approval and names the wallet being replaced.
  const other = core.newMnemonic();
  await svc.call("wallet.restore", { words: other });
  assert.match(fake.calls.confirms.at(-1).detail, new RegExp(address));

  await svc.call("wallet.remove", {});
  assert.equal((await svc.call("state", {})).hasWallet, false);
});

test("Local-Only: no request leaves, and the user is told why", async () => {
  const fake = createFakeApi({ privacyMode: "local-only" });
  const { svc } = await newWallet(fake);
  assert.equal((await svc.call("state", {})).localOnly, true);
  await assert.rejects(svc.call("balances", {}), /Local-Only/);
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "1" }), /Local-Only/);
  assert.equal(fake.calls.fetches.length, 0, "nothing was fetched");
});

test("every request goes through KAI's fetch; node trouble moves to the next node, chain answers don't", async () => {
  const fake = createFakeApi();
  const { svc, address } = await newWallet(fake);
  fake.node.state.balances.set(address, 5n * ONE);
  fake.node.state.failNext.push({ error: "rpc failed, AMQP connection is not open" });
  const b = await svc.call("balances", {});
  assert.equal(b.koin, "5");
  assert.ok(fake.calls.fetches.some((u) => u.includes("api.koinos.io")) && fake.calls.fetches.some((u) => u.includes("api.koinosblocks.com")), "fell over to the second node");
  assert.ok(fake.calls.fetches.every((u) => u.startsWith("https://")), "public HTTPS only");

  // An undeployed account: the "contract does not exist" answer is the chain's, not node trouble.
  const before = fake.calls.fetches.length;
  const info = await svc.call("activation.info", {});
  assert.equal(info.deployed, false);
  assert.ok(fake.calls.fetches.length - before < 10, "no retry storm on a real answer");
});

test("activation: needs enough mana and an approval; refuses an address registered to another key", async () => {
  const fake = createFakeApi();
  const { svc, address, words } = await newWallet(fake);
  let info = await svc.call("activation.info", {});
  assert.equal(info.active, false);
  assert.equal(info.enoughMana, false);
  await assert.rejects(svc.call("activation.start", {}), /needs about/);

  fake.node.state.contracts.set(address, { publicKey: keysOf([...core.newMnemonic().split(" ")]).publicKey });
  info = await svc.call("activation.info", {});
  assert.equal(info.keyMatches, false);
  assert.equal(info.active, false, "registered to someone else's key is not active");
  fake.node.state.rc.set(address, 100n * ONE);
  await assert.rejects(svc.call("activation.start", {}), /different post-quantum key/);

  fake.node.state.contracts.set(address, { publicKey: keysOf(words).publicKey });
  info = await svc.call("activation.info", {});
  assert.equal(info.active, true);
});

test("activation end to end: one approved transaction installs the contract and registers this wallet's key", async () => {
  const fake = createFakeApi();
  const { svc, address, words } = await newWallet(fake);
  fake.node.state.balances.set(address, 70n * ONE);
  fake.node.state.rc.set(address, 70n * ONE);
  fake.setApprove(false);
  await assert.rejects(svc.call("activation.start", {}), /Not approved/);
  assert.equal(fake.node.state.submitted.length, 0);
  assert.match(fake.calls.confirms.at(-1).detail, /can't be undone/);
  await new Promise((r) => setTimeout(r, 3100));
  fake.setApprove(true);
  assert.deepEqual(await svc.call("activation.start", {}), { started: true });
  for (let i = 0; i < 100 && !((await svc.call("state", {})).activation || {}).done; i++) await new Promise((r) => setTimeout(r, 50));
  const act = (await svc.call("state", {})).activation;
  assert.equal(act.error, null, act.error);
  assert.equal(act.step, "done");
  assert.equal(fake.node.state.submitted.length, 1, "one transaction");
  const ops = fake.node.state.submitted[0].operations;
  assert.ok(ops[0].upload_contract && ops[0].upload_contract.contract_id === address);
  assert.equal(ops[0].upload_contract.authorizes_transaction_application, true, "every authority locked to the contract");
  const c = fake.node.state.contracts.get(address);
  assert.ok(c.bytes > 50000, "the real pqwallet bytecode was uploaded");
  assert.deepEqual([...c.publicKey], [...keysOf(words).publicKey], "this wallet's ML-DSA-44 key registered");
  assert.equal((await svc.call("activation.info", {})).active, true);
  assert.deepEqual(await svc.call("activation.start", {}), { alreadyActive: true });
});

test("sending: checks, the new-recipient step, an approval, then a real ML-DSA-44 signed transaction", async () => {
  const fake = createFakeApi();
  const { svc, address, words } = await newWallet(fake);

  fake.node.state.balances.set(address, 10n * ONE);
  fake.node.state.rc.set(address, 10n * ONE);
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "1", confirmNew: RECIPIENT.slice(-6) }), /isn't activated/);

  activateOnChain(fake, address, words);
  await assert.rejects(svc.call("send", { to: "1notanaddress", amount: "1" }), /valid Koinos address/);
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "0" }), /above 0/);
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "1.123456789" }), /8 decimal/);
  await assert.rejects(svc.call("send", { to: address, amount: "1" }), /own address/);
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "1" }), /last 6 characters/, "a first-time recipient needs its last 6 typed");
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "500", confirmNew: RECIPIENT.slice(-6) }), /Not enough KOIN/);

  fake.setApprove(false);
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "1.5", confirmNew: RECIPIENT.slice(-6) }), /Not approved/);
  assert.equal(fake.node.state.submitted.length, 0, "nothing submitted when declined");
  const dlg = fake.calls.confirms.at(-1);
  assert.match(dlg.detail, /Amount: 1\.5 KOIN/);
  assert.match(dlg.detail, new RegExp(`To: ${RECIPIENT}`));
  assert.match(dlg.detail, /NEVER sent to this address/);

  await new Promise((r) => setTimeout(r, 3100));
  fake.setApprove(true);
  const sent = await svc.call("send", { to: RECIPIENT, amount: "1.5", confirmNew: RECIPIENT.slice(-6) });
  assert.match(sent.txId, /^0x1220[0-9a-f]{64}$/);
  assert.match(sent.explorer, /koinosblocks\.com\/tx\//);
  assert.equal(fake.node.state.submitted.length, 1);
  const tx = fake.node.state.submitted[0];
  assert.equal(tx.id, sent.txId);
  assert.equal(tx.header.payer, address);
  assert.equal(tx.signatures.length, 1);
  const entry = core.koilibUtils.decodeBase64url(tx.signatures[0]);
  assert.equal(entry.length, 2420, "a pqwallet ML-DSA-44 signature");
  assert.ok(core.verifyEntry(entry, tx.id, keysOf(words).publicKey, "pqwallet"), "the signature verifies against the wallet's key");
  const t = fake.node.decodeTransfer(tx.operations[0].call_contract.args);
  assert.deepEqual([t.from, t.to, t.value], [address, RECIPIENT, 150000000n]);
  assert.equal(fake.node.state.balances.get(address), 10000000000n - 150000000n);

  // Now known: no last-6 step, and the dialog says so.
  await svc.call("send", { to: RECIPIENT, amount: "0.25" });
  assert.match(fake.calls.confirms.at(-1).detail, /You have sent to this address before/);
  assert.equal(fake.node.state.submitted.length, 2);
  await new Promise((r) => setImmediate(r));
  assert.equal((await svc.call("send.status", { txId: sent.txId })).status, "mined");
});

test("address poisoning: a lookalike of a known address is flagged everywhere", async () => {
  const fake = createFakeApi();
  const { svc, address, words } = await newWallet(fake);
  activateOnChain(fake, address, words);
  // A planted address that starts and ends like one already used. (Finding a real colliding
  // address takes minutes of search, so the history is given one that shares the ends.)
  const planted = RECIPIENT.slice(0, 4) + "Z".repeat(26) + RECIPIENT.slice(-4);
  fake.store.set("known.mainnet", [planted, RECIPIENT]);
  const r = await svc.call("recipient.check", { to: OTHER });
  assert.equal(r.known, false);
  assert.equal(r.lookalike, null, "an unrelated new address is just new");
  fake.store.set("known.mainnet", [planted]);
  const r2 = await svc.call("recipient.check", { to: RECIPIENT });
  assert.equal(r2.known, false);
  assert.equal(r2.lookalike, planted, "same start and end as a used address: flagged");
  await svc.call("send", { to: RECIPIENT, amount: "1", confirmNew: RECIPIENT.slice(-6) });
  assert.match(fake.calls.confirms.at(-1).detail, /WARNING: it looks like/);
});
const OTHER = "1DGUf9QXa9a9PXipoD82ftWKW5dCsit8F1";


test("other plugins: refused until allowed; every payment approved in a dialog naming the plugin", async () => {
  const fake = createFakeApi();
  const { svc, address, words } = await newWallet(fake);
  activateOnChain(fake, address, words);
  await assert.rejects(fake.asPlugin("status", {}), /hasn't allowed other plugins/);
  await assert.rejects(fake.asPlugin("requestPayment", { to: RECIPIENT, amount: "1" }), /hasn't allowed/);
  assert.equal(fake.node.state.submitted.length, 0);

  fake.setApprove(false);
  await assert.rejects(svc.call("share.set", { on: true }), /Not approved/);
  assert.equal((await svc.call("state", {})).shareWithPlugins, false);
  await new Promise((r) => setTimeout(r, 3100));
  fake.setApprove(true);
  await svc.call("share.set", { on: true });

  assert.deepEqual(await fake.asPlugin("status", {}), { address, network: "mainnet" });
  assert.equal((await fake.asPlugin("balance", {})).koin, "100");

  fake.setApprove(false);
  await assert.rejects(fake.asPlugin("requestPayment", { to: RECIPIENT, amount: "2", reason: "Order 1042‮ evil" }), /Not approved/);
  const dlg = fake.calls.confirms.at(-1);
  assert.match(dlg.title, /community\.shop asks to send KOIN/);
  assert.match(dlg.detail, /The plugin "community\.shop" asks/);
  assert.match(dlg.detail, /Order 1042  evil/, "bidi controls stripped from the reason");
  assert.match(dlg.detail, /NEVER sent/);
  assert.equal(fake.node.state.submitted.length, 0);

  await new Promise((r) => setTimeout(r, 3100));
  fake.setApprove(true);
  const paid = await fake.asPlugin("requestPayment", { to: RECIPIENT, amount: "2" });
  assert.match(paid.txId, /^0x1220/);
  assert.equal(fake.node.state.submitted.length, 1);
  await assert.rejects(fake.asPlugin("exportKey", {}), /unknown method/);

  await svc.call("share.set", { on: false });
  await assert.rejects(fake.asPlugin("status", {}), /hasn't allowed/);
});

test("one approval at a time", async () => {
  let release;
  const fake = createFakeApi({ approve: () => new Promise((r) => { release = r; }) });
  const { svc, address, words } = await newWallet(fake);
  activateOnChain(fake, address, words);
  const first = svc.call("send", { to: RECIPIENT, amount: "1", confirmNew: RECIPIENT.slice(-6) });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(svc.call("wallet.reveal", {}), /already open/);
  release(false);
  await assert.rejects(first, /Not approved/);
});

test("explorer links are built by the service, never taken from the window", async () => {
  const fake = createFakeApi();
  const { svc, address } = await newWallet(fake);
  await svc.call("explorer.open", { txId: "0x1220" + "ab".repeat(32) });
  await svc.call("explorer.open", { address: true });
  await assert.rejects(svc.call("explorer.open", { txId: "https://evil.example/" }), /nothing to open/);
  assert.deepEqual(fake.calls.opened, ["https://koinosblocks.com/tx/0x1220" + "ab".repeat(32), `https://koinosblocks.com/address/${address}`]);
});

test("testnet uses its own node and the same address", async () => {
  const node = createFakeNode({ network: "testnet" });
  const fake = createFakeApi({ node });
  const { svc, address } = await newWallet(fake);
  await svc.call("network.set", { network: "testnet" });
  node.state.balances.set(address, 3n * ONE);
  assert.equal((await svc.call("balances", {})).koin, "3");
  assert.ok(fake.calls.fetches.at(-1).startsWith("https://testnet.koinosfoundation.org/"));
  await assert.rejects(svc.call("network.set", { network: "devnet" }), /unknown network/);
});

test("dialogs follow KAI's language", async () => {
  const fake = createFakeApi({ language: "de" });
  const { svc, address, words } = await newWallet(fake);
  activateOnChain(fake, address, words);
  fake.setApprove(false);
  await assert.rejects(svc.call("send", { to: RECIPIENT, amount: "1", confirmNew: RECIPIENT.slice(-6) }), /Nicht bestätigt/);
  assert.match(fake.calls.confirms.at(-1).detail, /Betrag: 1 KOIN/);
});

test("every language has every string (service and window)", () => {
  for (const [lang, cat] of Object.entries(serviceCatalogs)) {
    for (const k of Object.keys(serviceCatalogs.en)) assert.ok(k in cat, `service ${lang} is missing ${k}`);
  }
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../plugin/i18n.js"), "utf8"), ctx);
  const ui = ctx.window.SparanI18n.catalogs;
  for (const [lang, cat] of Object.entries(ui)) {
    for (const k of Object.keys(ui.en)) if (k !== "about") assert.ok(k in cat, `window ${lang} is missing ${k}`);
  }
  // Every data-i18n key in the page exists in English.
  const html = fs.readFileSync(path.join(__dirname, "../plugin/index.html"), "utf8");
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) assert.ok(key in ui.en, `index.html uses unknown key ${key}`);
});

test("the package asks only for what it uses, and never for KAI's own wallet or account", () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin/manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(m).sort(), ["apiVersion", "consumes", "description", "entry", "id", "name", "permissions", "provides", "runtime", "schema", "service", "version"].sort());
  assert.equal(m.schema, 2);
  assert.equal(m.apiVersion, 3);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  for (const p of m.permissions) assert.ok(!/^wallet\.|^account\.|^inference\.|^process\.|^files\./.test(p), `does not ask for ${p}`);
  assert.deepEqual(m.provides, ["koinos.pq-wallet"]);
  const src = ["index.js", "rpc.js"].map((f) => fs.readFileSync(path.join(__dirname, "../plugin/service", f), "utf8")).join("\n");
  assert.ok(!/api\.wallet\.|api\.account\./.test(src), "the service never touches KAI's wallet or account");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/api\.network\.fetch\(/g, "");
  assert.ok(!/(^|[^.\w])fetch\(/m.test(code), "no direct fetch() outside KAI's broker");
  const bundle = fs.readFileSync(path.join(__dirname, "../plugin/service/vendor/pq-core.cjs"), "utf8");
  assert.ok(!bundle.includes("node-fetch"), "the bundle carries no fetch implementation of its own");
  assert.ok(fs.existsSync(path.join(__dirname, "../plugin/service/vendor/THIRD-PARTY-LICENSES.txt")));
});

test("the window never builds HTML from data", () => {
  const app = fs.readFileSync(path.join(__dirname, "../plugin/app.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(app));
  const html = fs.readFileSync(path.join(__dirname, "../plugin/index.html"), "utf8");
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline scripts (KAI blocks them)");
  assert.ok(!/\son[a-z]+="/.test(html), "no inline handlers");
});
