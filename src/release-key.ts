// The Ed25519 public key (base64, raw 32 bytes) that signs release manifests (manifest.json.sig).
// `agentmbx update` trusts a release only if its manifest verifies against this key. While the placeholder is in
// place, update verification fails closed. Key handling and rotation: docs/RELEASING.md.
// A SEA build can pin a different key at build time (AGENTMBX_RELEASE_PUBKEY), used to test self-update end to end.
declare const __AGENTMBX_RELEASE_KEY__: string | undefined;

export const RELEASE_KEY_PLACEHOLDER = "PLACEHOLDER-RELEASE-PUBLIC-KEY";
export const RELEASE_PUBLIC_KEY: string =
  typeof __AGENTMBX_RELEASE_KEY__ !== "undefined" && __AGENTMBX_RELEASE_KEY__ ? __AGENTMBX_RELEASE_KEY__ : RELEASE_KEY_PLACEHOLDER;
