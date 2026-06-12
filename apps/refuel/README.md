# apps/refuel — original single-file front end (MISSING ARTIFACT)

SPEC §6.3 calls for the existing `apex-refuel.html` (working v0: real Aerodrome quote+swap
via ethers v6, wallet connect/chain-switch, x402 client with EIP-3009 signing and local 402
simulation, BRIDGE_MODE config, MCP curl stub) to be placed here **untouched**.

**The file was not present on the build machine** (searched Desktop, Downloads, and the
project tree on 2026-06-12). Drop it in as `apps/refuel/index.html` when located.

The React port at `apps/web/app/refuel` was built from the SPEC description and §1.4 CFG
values instead; reconcile the x402 payload format and CFG against the original when it lands.
