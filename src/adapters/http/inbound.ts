import type { InboundMessage } from "../../domain/contracts";

interface GenericWebhookPayload {
  sessionId?: string;
  actorId?: string;
  channel?: string;
  text?: string;
  accountId?: string;
  contactName?: string;
  message?: {
    text?: string;
  };
  conversation?: {
    id?: string | number;
  };
  sender?: {
    id?: string | number;
    name?: string;
  };
  [key: string]: unknown;
}

export function normalizeInboundMessage(payload: GenericWebhookPayload): InboundMessage {
  const text = payload.text ?? payload.message?.text;
  if (!text || typeof text !== "string") {
    throw new Error("Unable to normalize inbound payload: missing text");
  }

  return {
    sessionId: String(payload.sessionId ?? payload.conversation?.id ?? crypto.randomUUID()),
    actorId: String(payload.actorId ?? payload.sender?.id ?? "anonymous"),
    channel: String(payload.channel ?? "generic_http"),
    text,
    accountId: payload.accountId ? String(payload.accountId) : undefined,
    contactName: payload.contactName ?? payload.sender?.name,
    rawPayload: payload,
    receivedAt: new Date().toISOString()
  };
}
