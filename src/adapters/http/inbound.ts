import type { InboundMessage } from "../../domain/contracts";

interface GenericWebhookPayload {
  sessionId?: string;
  actorId?: string;
  channel?: string;
  text?: string;
  correlationId?: string;
  correlation_id?: string;
  parentRunId?: string;
  parent_run_id?: string;
  trigger?: string;
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
    correlationId: payload.correlationId ? String(payload.correlationId) : payload.correlation_id ? String(payload.correlation_id) : undefined,
    parentRunId: payload.parentRunId ? String(payload.parentRunId) : payload.parent_run_id ? String(payload.parent_run_id) : undefined,
    trigger: payload.trigger ? String(payload.trigger) : "http_message",
    accountId: payload.accountId ? String(payload.accountId) : undefined,
    contactName: payload.contactName ?? payload.sender?.name,
    rawPayload: payload,
    receivedAt: new Date().toISOString()
  };
}
