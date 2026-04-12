import type { InboundMessage, TurnOutcome } from "../../domain/contracts";
import type { OutboundTransport } from "../../domain/ports";

export class NoopTransport implements OutboundTransport {
  async emit(outcome: TurnOutcome, inbound: InboundMessage): Promise<void> {
    console.info(
      JSON.stringify({
        event: "outbound_skipped",
        sessionId: inbound.sessionId,
        channel: inbound.channel,
        responseText: outcome.responseText
      })
    );
  }
}
