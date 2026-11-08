"use strict";
// Sparán window. Everything the wallet does happens in the native service (service/index.js);
// this page only shows state and passes the user's choices on. Text from the chain, addresses
// and recovery words go in with textContent, never as HTML.
(function () {
  const I = window.SparanI18n;
  const t = (k, p) => I.t(k, p);
  const $ = (id) => document.getElementById(id);
  const call = (method, input) => window.kai.call(method, input || {});
  let state = null, busy = false, words = null, checkIdx = [], pollTimer = null, sendPoll = null, lastSend = null;

  function show(id, on) { $(id).hidden = !on; }
  function showError(message) { $("error").hidden = !message; $("error").textContent = message || ""; }
  function errText(e) { return (e && e.message ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, ""); }

  async function act(fn) {
    if (busy) return;
    busy = true;
    for (const b of document.querySelectorAll("button")) b.disabled = true;
    try { showError(""); await fn(); }
    catch (e) { showError(errText(e)); }
    finally {
      busy = false;
      for (const b of document.querySelectorAll("button")) b.disabled = false;
      await refresh();
    }
  }

  function pill(kind) {
    const p = $("pill");
    p.className = "pill" + (kind === "pillActive" ? " on" : kind === "pillNotActive" || kind === "pillLocal" ? " off" : "");
    p.textContent = t(kind);
  }

  async function refresh() {
    try { state = await call("state"); } catch (e) { showError(errText(e)); return; }
    $("network").value = state.network;
    $("share").checked = !!state.shareWithPlugins;
    $("about").textContent = t("about", { sha: state.pqwalletWasmSha256 });
    const notices = [];
    if (state.localOnly) notices.push(t("localOnly"));
    if (state.network === "testnet") notices.push(t("testnetNote"));
    $("notice").hidden = !notices.length;
    $("notice").textContent = notices.join(" ");

    const creating = !$("words-card").hidden || !$("restore-card").hidden;
    if (!state.hasWallet) {
      pill("pillNoWallet");
      show("setup", !creating && state.secureStorage);
      for (const id of ["wallet", "activate", "send", "history-card", "settings"]) show(id, false);
      if (!state.secureStorage) showError(t("noSecure"));
      return;
    }
    show("setup", false);
    show("wallet", true);
    show("settings", true);
    $("address").textContent = state.address;
    if (state.localOnly) {
      pill("pillLocal");
      for (const id of ["activate", "send", "history-card"]) show(id, false);
      $("koin").textContent = "—"; $("mana").textContent = "—";
      return;
    }
    await loadChain();
  }

  async function loadChain() {
    pill("pillChecking");
    try {
      const [b, a] = await Promise.all([call("balances"), call("activation.info")]);
      $("koin").textContent = b.koin;
      $("mana").textContent = b.mana;
      const running = state.activation && !state.activation.done;
      show("activate", !a.active || running || (state.activation && state.activation.done));
      show("send", a.active);
      pill(a.active ? "pillActive" : "pillNotActive");
      $("activate-need").textContent = a.enoughMana ? t("needOk", { have: a.mana, need: a.requiredMana }) : t("needLine", { have: a.mana, need: a.requiredMana });
      $("activate-need").hidden = a.active;
      $("btn-activate").hidden = a.active || running;
      $("btn-activate").disabled = !a.enoughMana;
      renderActivation(a.active);
      await loadHistory();
    } catch (e) {
      pill("pillNotActive");
      showError(errText(e));
    }
  }

  function renderActivation(active) {
    const s = state.activation;
    const el = $("activate-progress");
    if (!s) { el.hidden = true; return; }
    el.hidden = false;
    if (s.error) el.textContent = t("activationFailed", { error: s.error });
    else if (s.done || active) el.textContent = t("activated");
    else el.textContent = t("activating", { message: s.message || "" }) + (s.txId ? ` (${s.txId})` : "");
    clearTimeout(pollTimer);
    if (!s.done) pollTimer = setTimeout(refresh, 5000);
  }

  async function loadHistory() {
    const list = $("history");
    show("history-card", true);
    let items = [];
    try { items = (await call("history", { limit: 20 })).items || []; } catch (e) { items = []; }
    list.textContent = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "meta";
      li.textContent = t("noHistory");
      list.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      const amt = document.createElement("span");
      amt.className = "amt" + (it.direction === "in" ? " in" : "");
      const unit = it.isKoin ? " KOIN" : "";
      const who = it.counterparty ? `${it.counterparty.slice(0, 6)}…${it.counterparty.slice(-4)}` : "?";
      amt.textContent = it.direction === "in" ? t("received", { amt: (it.amount || "?") + unit, from: who })
        : it.direction === "out" ? t("sentTo", { amt: (it.amount || "?") + unit, to: who }) : t("otherActivity");
      left.appendChild(amt);
      if (it.reverted) left.appendChild(document.createTextNode(" " + t("reverted")));
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = it.blockHeight ? `#${it.blockHeight} ` : "";
      if (it.txId && it.explorer) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = t("explorer");
        b.addEventListener("click", () => act(() => call("explorer.open", { txId: it.txId })));
        meta.appendChild(b);
      }
      li.append(left, meta);
      list.appendChild(li);
    }
  }

  // ----- new wallet -----
  function pickChecks() {
    const set = new Set();
    while (set.size < 3) set.add(Math.floor(Math.random() * 24));
    return [...set].sort((a, b) => a - b);
  }
  function renderWords(list) {
    const ol = $("words");
    ol.textContent = "";
    for (const w of list) { const li = document.createElement("li"); li.textContent = w; ol.appendChild(li); }
  }

  $("btn-new").addEventListener("click", () => act(async () => {
    words = (await call("wallet.generate")).words;
    renderWords(words);
    show("words-card", true); show("setup", false); show("check", false);
    $("btn-written").hidden = false; $("btn-save-new").hidden = true;
  }));
  $("btn-written").addEventListener("click", () => {
    checkIdx = pickChecks();
    const box = $("check-fields");
    box.textContent = "";
    for (const i of checkIdx) {
      const label = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = t("wordN", { n: i + 1 });
      const input = document.createElement("input");
      input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.dataset.index = String(i);
      label.append(span, input);
      box.appendChild(label);
    }
    $("words").textContent = ""; // hide the list while they check from paper
    show("check", true);
    $("btn-written").hidden = true; $("btn-save-new").hidden = false;
  });
  $("btn-save-new").addEventListener("click", () => act(async () => {
    const checks = [...$("check-fields").querySelectorAll("input")].map((el) => ({ index: Number(el.dataset.index), word: el.value }));
    await call("wallet.confirmGenerated", { checks });
    words = null;
    show("words-card", false);
  }));
  $("btn-cancel-new").addEventListener("click", () => { words = null; show("words-card", false); refresh(); });

  // ----- restore -----
  $("btn-restore").addEventListener("click", () => { show("restore-card", true); show("setup", false); $("restore-words").focus(); });
  $("btn-restore-cancel").addEventListener("click", () => { $("restore-words").value = ""; show("restore-card", false); refresh(); });
  $("btn-restore-go").addEventListener("click", () => act(async () => {
    await call("wallet.restore", { words: $("restore-words").value });
    $("restore-words").value = "";
    show("restore-card", false);
  }));

  // ----- wallet -----
  $("btn-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.address); $("btn-copy").textContent = t("copied"); setTimeout(() => { $("btn-copy").textContent = t("copy"); }, 1500); }
    catch (e) { showError(errText(e)); }
  });
  $("btn-explorer-addr").addEventListener("click", () => act(() => call("explorer.open", { address: true })));
  $("btn-refresh").addEventListener("click", () => act(async () => {}));
  $("network").addEventListener("change", () => act(() => call("network.set", { network: $("network").value })));
  $("btn-activate").addEventListener("click", () => act(() => call("activation.start")));

  // ----- send -----
  let checkTimer = null;
  async function checkRecipient() {
    const to = $("to").value.trim();
    const note = $("to-note");
    if (!to) { note.hidden = true; show("confirm-new-field", false); return null; }
    const r = await call("recipient.check", { to });
    note.hidden = false;
    note.className = "hint";
    if (!r.valid) { note.textContent = t("toInvalid"); show("confirm-new-field", false); return r; }
    if (r.self) { note.textContent = t("toSelf"); show("confirm-new-field", false); return r; }
    if (r.known) { note.textContent = t("toKnown"); show("confirm-new-field", false); return r; }
    note.textContent = r.lookalike ? t("toLookalike", { addr: r.lookalike }) + " " + t("toNew") : t("toNew");
    if (r.lookalike) note.className = "warn";
    show("confirm-new-field", true);
    return r;
  }
  $("to").addEventListener("input", () => { clearTimeout(checkTimer); checkTimer = setTimeout(() => checkRecipient().catch(() => {}), 250); });
  $("btn-send").addEventListener("click", () => act(async () => {
    const to = $("to").value.trim();
    const r = await checkRecipient();
    const confirmNew = r && r.valid && !r.known ? $("confirm-new").value.trim() : undefined;
    const sent = await call("send", { to, amount: $("amount").value.trim(), confirmNew });
    lastSend = sent.txId;
    $("amount").value = ""; $("confirm-new").value = "";
    const out = $("send-result");
    out.hidden = false;
    out.textContent = t("sentWait", { tx: sent.txId });
    clearInterval(sendPoll);
    sendPoll = setInterval(async () => {
      const s = await call("send.status", { txId: lastSend }).catch(() => null);
      if (!s || s.status === "sent") return;
      clearInterval(sendPoll);
      out.textContent = s.status === "mined" ? `${sent.txId}: ${t("sentMined", { block: s.block })}` : t("sentUnconfirmed");
      refresh();
    }, 4000);
  }));

  // ----- settings -----
  $("share").addEventListener("change", () => act(() => call("share.set", { on: $("share").checked })));
  $("btn-reveal").addEventListener("click", () => act(async () => {
    const r = await call("wallet.reveal");
    renderWords(r.words);
    show("words-card", true); show("check", false);
    $("btn-written").hidden = true; $("btn-save-new").hidden = true;
    $("btn-cancel-new").textContent = t("hide");
  }));
  $("btn-remove").addEventListener("click", () => act(() => call("wallet.remove")));

  // ----- language: follow KAI's setting -----
  function applyLanguage(st) {
    I.set(st && st.language);
    document.documentElement.lang = I.language;
    document.documentElement.dir = (st && st.direction) || "ltr";
    I.apply();
    if (state) refresh();
  }
  let revision = 0;
  const unsubscribe = window.kai.locale && window.kai.locale.onChange ? window.kai.locale.onChange((s) => { revision++; applyLanguage(s); }) : () => {};
  window.addEventListener("pagehide", () => { unsubscribe(); clearTimeout(pollTimer); clearInterval(sendPoll); words = null; }, { once: true });
  (async () => {
    const initial = revision;
    try {
      const st = window.kai.locale ? await window.kai.locale.get() : null;
      if (revision === initial) applyLanguage(st);
    } catch { applyLanguage(null); }
    await refresh();
  })();
})();
