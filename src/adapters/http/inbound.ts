import type { InboundMessage } from "../../domain/contracts";

interface GenericWebhookPayload {
  event?: string;
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
  account?: {
    id?: string | number;
  };
  inbox?: {
    id?: string | number;
  };
  sender?: {
    id?: string | number;
    name?: string;
    type?: string;
  };
  id?: string | number;
  message_type?: string | number;
  private?: boolean;
  content?: string;
  [key: string]: unknown;
}

interface ChatwootWebhookAssessment {
  isChatwoot: boolean;
  shouldProcess: boolean;
  reason?: string;
}

const CHATWOOT_INCOMING_TYPES = new Set(["incoming", "0", 0]);

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

export function assessChatwootWebhook(payload: GenericWebhookPayload): ChatwootWebhookAssessment {
  const isChatwoot =
    payload.event !== undefined ||
    payload.message_type !== undefined ||
    payload.account?.id !== undefined ||
    payload.inbox?.id !== undefined;

  if (!isChatwoot) {
    return {
      isChatwoot: false,
      shouldProcess: true
    };
  }

  if (payload.event && payload.event !== "message_created") {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: `ignored_event:${payload.event}`
    };
  }

  if (payload.private === true) {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: "ignored_private_message"
    };
  }

  const messageType = payload.message_type;
  if (messageType !== undefined && !CHATWOOT_INCOMING_TYPES.has(messageType)) {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: `ignored_message_type:${String(messageType)}`
    };
  }

  if (payload.sender?.type && payload.sender.type !== "contact") {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: `ignored_sender_type:${payload.sender.type}`
    };
  }

  return {
    isChatwoot: true,
    shouldProcess: true
  };
}

export function normalizeChatwootInboundMessage(payload: GenericWebhookPayload): InboundMessage {
  const text = payload.content ?? payload.text ?? payload.message?.text;
  if (!text || typeof text !== "string") {
    throw new Error("Unable to normalize Chatwoot payload: missing content");
  }

  const conversationId = payload.conversation?.id ?? payload.sessionId ?? crypto.randomUUID();
  const accountId = payload.account?.id ?? payload.accountId;
  const inboxId = payload.inbox?.id;
  const contactId = payload.sender?.id ?? payload.actorId;

  return {
    sessionId: String(conversationId),
    actorId: String(contactId ?? "anonymous"),
    channel: "chatwoot",
    text,
    correlationId: String(payload.id ?? conversationId),
    trigger: payload.event ? `chatwoot:${payload.event}` : "chatwoot:message_created",
    accountId: accountId ? String(accountId) : undefined,
    contactName: payload.contactName ?? payload.sender?.name,
    deliveryContext: {
      provider: "chatwoot",
      accountId: accountId ? String(accountId) : undefined,
      conversationId: String(conversationId),
      inboxId: inboxId ? String(inboxId) : undefined,
      contactId: contactId ? String(contactId) : undefined
    },
    rawPayload: payload,
    receivedAt: new Date().toISOString()
  };
}
