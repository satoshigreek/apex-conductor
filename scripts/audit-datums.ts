/**
 * M1 task 1 — datum audit (resolves BLOCKER-3).
 * Fetches live registry UTxOs from Vector MAINNET Koios (§1.3), decodes inline datums,
 * prints decoded fields, writes docs/datum-audit.md.
 *
 * Run: pnpm audit:datums
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KoiosClient } from "../packages/chain-vector/src/koios.js";
import { decodeAgentDatum } from "../packages/chain-vector/src/plutus.js";

const MAINNET_KOIOS = "https://koios.vector.apexfusion.org/api/v1";
const REGISTRY_ADDR = "addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42";
const REGISTRY_POLICY = "be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const koios = new KoiosClient({ baseUrl: MAINNET_KOIOS, timeoutMs: 30_000 });
  console.log(`tip check: ${MAINNET_KOIOS}/tip`);
  const tip = await koios.tip();
  console.log(`vector mainnet tip: block ${tip.block_no} epoch ${tip.epoch_no} (${new Date(tip.block_time * 1000).toISOString()})`);

  console.log(`fetching registry UTxOs at ${REGISTRY_ADDR} ...`);
  const utxos = await koios.addressUtxos(REGISTRY_ADDR, true);
  console.log(`found ${utxos.length} UTxOs at the registry script address`);

  const lines: string[] = [
    "# Registry Datum Audit (M1 — BLOCKER-3 resolution)",
    "",
    `- **Date:** ${new Date().toISOString()}`,
    `- **Koios:** \`${MAINNET_KOIOS}\``,
    `- **Script address:** \`${REGISTRY_ADDR}\``,
    `- **Policy:** \`${REGISTRY_POLICY}\``,
    `- **Chain tip:** block ${tip.block_no}, epoch ${tip.epoch_no}`,
    `- **UTxOs found:** ${utxos.length}`,
    "",
  ];

  const sample = utxos.slice(0, Math.max(5, Math.min(10, utxos.length)));
  let withDatum = 0;
  let withEndpoint = 0;
  let withPricing = 0;

  for (const [i, utxo] of sample.entries()) {
    const datum = utxo.inline_datum?.value ?? null;
    if (datum) withDatum++;
    const decoded = decodeAgentDatum(datum);
    if (decoded.endpointUrl) withEndpoint++;
    if (decoded.pricingAmount !== null) withPricing++;
    const assets = (utxo.asset_list ?? [])
      .filter((a) => a.policy_id === REGISTRY_POLICY)
      .map((a) => a.asset_name ?? "")
      .join(", ");
    lines.push(
      `## UTxO ${i + 1}: \`${utxo.tx_hash}#${utxo.tx_index}\``,
      "",
      `- registry assets: \`${assets || "(none)"}\``,
      `- has inline datum: **${datum ? "yes" : "NO"}**`,
      `- extracted name: \`${decoded.name ?? "—"}\``,
      `- extracted capabilities: \`${decoded.capabilities.join(", ") || "—"}\``,
      `- extracted endpoint: \`${decoded.endpointUrl ?? "— (BLOCKER-3)"}\``,
      `- extracted pricing: \`${decoded.pricingAmount ?? "— (BLOCKER-3)"}\``,
      `- extracted stake: \`${decoded.stake ?? "—"}\``,
      `- extracted ownerPkh: \`${decoded.ownerPkh ?? "—"}\``,
      "",
      "<details><summary>decoded datum tree</summary>",
      "",
      "```json",
      JSON.stringify(decoded.decoded, null, 2),
      "```",
      "",
      "</details>",
      "",
    );
    console.log(`utxo ${i + 1}: name=${decoded.name} endpoint=${decoded.endpointUrl} caps=[${decoded.capabilities}]`);
  }

  const blocker3Confirmed = withEndpoint < sample.length || withPricing < sample.length;
  lines.push(
    "## Verdict",
    "",
    `- datums present: ${withDatum}/${sample.length}`,
    `- endpoint field decodable: ${withEndpoint}/${sample.length}`,
    `- pricing field decodable: ${withPricing}/${sample.length}`,
    "",
    blocker3Confirmed
      ? "**BLOCKER-3 CONFIRMED** — the live datum schema does not (fully) carry `endpoint`/`pricing`. " +
        "`AgentProfileResolver` merges on-chain datums with signed off-chain manifests " +
        "(`agent_manifests` table; operators POST a manifest whose signature verifies against `ownerPkh`). " +
        "Cross-check the authoritative datum schema in `Apex-Fusion/vector-ai-agents` `DEPLOY.md` and refine " +
        "`packages/chain-vector/src/plutus.ts → decodeAgentDatum` accordingly.",
    "**BLOCKER-3 NOT confirmed** — datums carry endpoint+pricing; the manifest fallback stays as a redundancy path.",
  );
  if (!blocker3Confirmed) lines.splice(lines.length - 2, 1); // keep only the matching verdict line
  else lines.splice(lines.length - 1, 1);

  mkdirSync(join(root, "docs"), { recursive: true });
  const out = join(root, "docs", "datum-audit.md");
  writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`\nwrote ${out}`);
  console.log(blocker3Confirmed ? "VERDICT: BLOCKER-3 CONFIRMED (manifest fallback required)" : "VERDICT: datums complete");
}

main().catch((err) => {
  console.error(`datum audit failed: ${(err as Error).message}`);
  process.exit(1);
});
