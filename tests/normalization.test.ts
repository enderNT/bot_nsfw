import { describe, expect, it } from "bun:test";
import { normalizeInboundMessage } from "../src/adapters/http/inbound";

describe("normalizeInboundMessage", () => {
  it("maps a generic channel payload to the internal contract", () => {
    const inbound = normalizeInboundMessage({
      conversation: { id: 123 },
      sender: { id: 456, name: "Ana" },
      message: { text: "Hola" },
      channel: "demo-channel"
    });

    expect(inbound.sessionId).toBe("123");
    expect(inbound.actorId).toBe("456");
    expect(inbound.text).toBe("Hola");
    expect(inbound.contactName).toBe("Ana");
    expect(inbound.channel).toBe("demo-channel");
  });
});
