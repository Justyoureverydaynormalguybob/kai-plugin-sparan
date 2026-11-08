# Sparán for KAI

A post-quantum Koinos wallet as a [KAI Core](https://koinosai.com) plugin. *Sparán* (spuh-RAWN) is the Irish word for a purse.

The account is a [koinos-pq](https://github.com/Justyoureverydaynormalguybob/koinos-pq) `pqwallet` account: the koinos-pq contract is installed on the address with every authority locked to it, and only an **ML-DSA-44** (NIST FIPS 204) signature can move its KOIN. The key that a large quantum computer could one day break stops counting. The signing rules come from [koinos-pq-core](https://github.com/Justyoureverydaynormalguybob/koinos-pq-core), the same code as the Sparán browser wallet.

- Plugin ID `community.sparan`, version 0.1.0, native runtime, for KAI Core 0.7.17 or later.
- Works on Koinos mainnet and Harbinger testnet. The same 24 words give the same address on both.
- A showcase: it works on mainnet but has had no professional audit. Keep amounts you can afford to lose.

## What it does

| | |
| --- | --- |
| **Wallet** | Create a new wallet (24 words, with a three-word check that you wrote them down) or restore one. Balance, mana and recent activity. |
| **Activate** | One transaction installs the koinos-pq contract on the address and registers this wallet's ML-DSA-44 key, then Sparán checks the chain holds exactly that key. It needs about 65 KOIN of mana on mainnet (8 on Harbinger), priced from the live resource market. Mana isn't spent KOIN: it refills over 5 days. |
| **Send** | KOIN transfers signed with ML-DSA-44 and checked locally before they leave. |
| **Other plugins** | Provides the local service `koinos.pq-wallet` (`status`, `balance`, `requestPayment`), off until you allow it. |

## How it keeps you in charge

| Rule | How |
| --- | --- |
| The key stays encrypted | The 32-byte seed is encrypted with your operating system's secret store through `api.secrets` and kept in the plugin's own settings. No plain-text copy is written. Sparán refuses to hold a key where the OS can't really encrypt (no secret store, or Linux's `basic_text` fallback). The seed is decrypted only for the operation that needs it and wiped afterwards. |
| You approve everything that matters | Sending, activating, showing the recovery words, replacing or removing the wallet, and letting other plugins in all go through KAI's own approval (`api.desktop.confirm`). It returns false while KAI is hidden, so nothing is approved in the background. One approval at a time, with a pause after a decline. |
| New addresses are checked | The first send to an address needs its last 6 characters typed. An address that starts and ends like one you've used (address poisoning) is flagged in the window and in the approval. |
| Other plugins can only ask | `koinos.pq-wallet` refuses every call until you tick **Let other KAI plugins use this wallet**, which itself needs approval. Even then, every `requestPayment` opens an approval that names the plugin asking and shows its reason, with control and bidi characters stripped. There's no method to export a key or sign arbitrary data. |
| Network through KAI only | Every request goes through `api.network.fetch` (public HTTPS, DNS-checked, no redirects), so **Local-Only stops the wallet reaching Koinos**. The bundled koilib's own fetch is replaced by a stub that refuses. Mainnet falls over from `api.koinos.io` to `api.koinosblocks.com` when a node errors; a real answer from the chain is never retried elsewhere. |
| Nothing kept that needn't be | No logs of keys, amounts or addresses. The only history kept is the list of addresses you've sent to (for the new-address check). |

### Never there, at any setting

- KAI's own wallet and account: the manifest doesn't ask for `wallet.*` or `account.request`. KAI's credits wallet is separate and untouched; a plugin can't sign with it anyway.
- Key export, arbitrary signing, or anything that runs code or reads files.

The tests enforce these: they grep the service and manifest for the banned families.

### What it cannot protect against

- **It's native code.** Like every native KAI plugin, it runs with KAI's rights on your computer, and so could any other native plugin you install. Software running as you can try to use the OS secret store too.
- **Your 24 words are the wallet.** Anyone who sees them can take the KOIN. Lose them and this computer, and nobody can get it back.
- **Post-quantum covers the account, not the chain.** Koinos still signs its blocks with today's keys; see koinos-pq's `docs/NATIVE-PROPOSAL.md` for the network-wide change.

## Permissions

- `native.execute`: the service. `storage.read` / `storage.write`: its settings and the encrypted key.
- `network.status` / `network.fetch`: Koinos JSON-RPC through KAI's broker.
- `secrets.use`: encrypting the key. `desktop.external`: opening the explorer (KAI reviews each URL, which the service builds from a checked transaction id).
- `services.provide`: `koinos.pq-wallet`.

## Install

1. In KAI: **Plugins → Install 3rd Party Plugins**, choose `dist/kai-plugin-sparan-<version>.kaiplugin`, check the publisher fingerprint below, and accept the full-access notice for a native plugin.
2. Open **Sparán**, create or restore a wallet, send about 65 KOIN to the address, then **Activate**.

Publisher fingerprint: see `RELEASE_NOTES.md` (same key as MCP Bridge).

## For other plugins

```js
// manifest: "consumes": ["koinos.pq-wallet"], permission "services.call"
const { address, network } = await api.services.call("koinos.pq-wallet", "status", {}, { signal });
const { koin, mana } = await api.services.call("koinos.pq-wallet", "balance", {}, { signal });
const { txId } = await api.services.call("koinos.pq-wallet", "requestPayment",
  { to: "1…", amount: "2.5", reason: "Order 1042" }, { signal }); // the user approves, or it throws
```

Amounts are decimal KOIN strings with at most 8 places. A declined or unanswered approval throws; never retry without asking the user.

## Build, test, sign

```sh
npm ci
npm run bundle     # plugin/service/vendor/pq-core.cjs + THIRD-PARTY-LICENSES.txt, from the locked koinos-pq-core
npm test           # node:test against a fake KAI API and a fake Koinos node
node test/live-read.js   # optional, read-only, real mainnet and Harbinger
node scripts/pack.js --core <kai-core checkout> --key <ed25519 key outside this repo>
```

The tests run the real service: a send is built by koilib, signed with ML-DSA-44 and checked against the wallet's key; activation uploads the real pqwallet bytecode and registers the key. `scripts/pack.js` rebuilds the bundle and refuses to sign if it differs from what's committed, refuses uncommitted plugin files and a key inside the repo, and never overwrites a release.

## For KAI maintainers

Offered for the KAI plugin catalog, entirely your call:

- **List it as is**: `community.sparan` under its current publisher key (the same key as `community.mcp-bridge`).
- **Adopt it**: re-sign it under your key with your own ID. Core binds an ID to its first publisher, so adopting means a new ID. MIT licensed.
- **Leave it**: it works as a third-party install.

Two things that would help any wallet-style plugin:

1. **Funding from the Core wallet.** Moving KOIN from the Core wallet into a plugin's address today means copying the address into Wallet → Send. A reviewed Core action such as `wallet.authorize("transfer-request", { to, amount, reason })`, which opens Core's own send review prefilled and names the requesting plugin, would let a plugin offer "Fund from my KAI wallet" without ever touching the Core key.
2. **A visible-window signal for approvals.** `desktop.confirm` returns false while KAI is in the tray, which is right; a way for a service to ask Core to bring its window forward (with the user's say-so) would make payments requested by other plugins less confusing.

## Licence

MIT. Bundled third-party licences are in `plugin/service/vendor/THIRD-PARTY-LICENSES.txt`.
