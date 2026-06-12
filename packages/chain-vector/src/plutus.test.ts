import { describe, expect, it } from "vitest";
import { decodeAgentDatum, decodePlutus, decodedToJson, hexToUtf8 } from "./plutus.js";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

describe("decodePlutus", () => {
  it("decodes bytes/int/list/constructor", () => {
    const d = decodePlutus({
      constructor: 0,
      fields: [{ bytes: hex("SummarizerAgent") }, { int: 500 }, { list: [{ bytes: hex("news") }, { bytes: hex("summarize") }] }],
    });
    expect(decodedToJson(d)).toEqual({ tag: 0, values: ["SummarizerAgent", "500", ["news", "summarize"]] });
  });

  it("keeps non-printable bytes as hex", () => {
    expect(hexToUtf8("00ff01")).toBe("0x00ff01");
    expect(hexToUtf8(hex("hello"))).toBe("hello");
  });
});

describe("decodeAgentDatum", () => {
  it("extracts from a CIP-68-style map datum", () => {
    const datum = {
      constructor: 0,
      fields: [
        {
          map: [
            { k: { bytes: hex("name") }, v: { bytes: hex("PriceQuoteAgent") } },
            { k: { bytes: hex("endpoint") }, v: { bytes: hex("https://agents.example/price") } },
            { k: { bytes: hex("stake") }, v: { int: 750 } },
            { k: { bytes: hex("capabilities") }, v: { list: [{ bytes: hex("price") }, { bytes: hex("quote") }] } },
          ],
        },
      ],
    };
    const out = decodeAgentDatum(datum);
    expect(out.name).toBe("PriceQuoteAgent");
    expect(out.endpointUrl).toBe("https://agents.example/price");
    expect(out.stake).toBe(750);
    expect(out.capabilities).toEqual(["price", "quote"]);
  });

  it("falls back to positional heuristics for bare constructor datums (BLOCKER-3 shape)", () => {
    const datum = {
      constructor: 0,
      fields: [
        { bytes: hex("ContractAuditor") },
        { bytes: "a".repeat(56) }, // pkh-shaped
        { bytes: hex("https://auditor.example/health") },
      ],
    };
    const out = decodeAgentDatum(datum);
    expect(out.name).toBe("ContractAuditor");
    expect(out.ownerPkh).toBe("a".repeat(56));
    expect(out.endpointUrl).toBe("https://auditor.example/health");
  });

  it("never throws on garbage", () => {
    expect(() => decodeAgentDatum(null)).not.toThrow();
    expect(() => decodeAgentDatum({ unexpected: true })).not.toThrow();
    expect(decodeAgentDatum(undefined).name).toBeNull();
  });
});
