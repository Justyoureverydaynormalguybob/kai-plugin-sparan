// What the plugin's service uses from koinos-pq-core, bundled with its dependencies
// (koilib, @noble/post-quantum, @noble/hashes, @scure/bip39) into one CommonJS file,
// because KAI loads native plugin code only from inside the signed package.
export {
  newMnemonic, isMnemonic, normalizeMnemonic, mnemonicToSeed, seedToMnemonic, deriveKeys, wipe,
  bootstrapAddress, setupPqwalletAccount, estimateSetupCosts, pqwalletInfo, registeredPublicKey,
  Chain, NETWORKS, formatKoin, parseKoin, isAddress, short, KOIN_DECIMALS,
  PQWALLET_WASM_SHA256, PQWALLET_SOURCE,
  verifyEntry, // used by the tests to check a submitted transaction's ML-DSA-44 signature
} from "koinos-pq-core";
// base58 and base64url helpers, for the tests' fake Koinos node.
export { utils as koilibUtils } from "koilib";
