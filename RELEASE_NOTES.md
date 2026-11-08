# Release notes

## 0.1.0 (2026-11-08)

First release.

- Create a wallet (24 words, three-word check) or restore one; the seed is encrypted by the OS secret store.
- Activate: one transaction installs the koinos-pq pqwallet contract (sha256 `8b1175cd70c58a015e6f2acee794bf30f5cefa584b25e5963742e9c5e5b3861a`) and registers the ML-DSA-44 key; the registered key is read back and compared.
- Send KOIN signed with ML-DSA-44, checked locally first. First-time recipients need their last 6 characters typed; lookalike addresses are flagged.
- `koinos.pq-wallet` service for other plugins (`status`, `balance`, `requestPayment`), off until allowed; every payment approved in a dialog naming the caller.
- Mainnet and Harbinger testnet. All requests through KAI's network broker; Local-Only stops them.
- English, Español, Português (Brasil), Français, Deutsch, following KAI's language setting.
- Bundles koinos-pq-core `b723619` (koilib 9.4.1, @noble/post-quantum, @noble/hashes, @scure/bip39).

| File | `dist/kai-plugin-sparan-0.1.0.kaiplugin` |
| --- | --- |
| Publisher fingerprint | `0d4883f800992901f1f4941e898031aafd10926cd5d87c0b0cfd166840df416b` (same key as MCP Bridge) |
| Package digest | `fac6916289aa81431588a6c9b9d2089832fa564684878fe18581020492706174` |
| File SHA-256 | `3905ad443dfc5b503f3e1d5c5b20c1e414648663bff2bb3a7f1788d16b4742a8` |
| Packed and verified with | KAI Core `e296ab9` (0.7.22) `scripts/core/pack-plugin.js` and `verifyPackage` |

Checked before release: 18 unit tests (fake KAI API and fake Koinos node, including a real ML-DSA-44 signature check and an end-to-end activation), the service loading through Core's own `loadNative`, and a read-only run against real mainnet and Harbinger (`test/live-read.js`). Not yet checked: the signed package installed in the KAI desktop app.
