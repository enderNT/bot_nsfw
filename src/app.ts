import { Elysia } from "elysia";
import { loadSettings } from "./config";
import { NoopTransport } from "./adapters/channels/noop-transport";
import { normalizeInboundMessage } from "./adapters/http/inbound";
import { TurnOrchestrator } from "./core/orchestrator";
import { GenericLlmProvider } from "./core/services/generic-llm-provider";
import { HttpDspyBridge } from "./core/services/http-dspy-bridge";
import { InMemoryMemoryProvider } from "./core/services/in-memory-memory-provider";
import { InMemoryStateStore } from "./core/services/in-memory-state-store";
import { InMemoryTraceSink } from "./core/services/in-memory-trace-sink";
import { NoopKnowledgeProvider } from "./core/services/noop-knowledge-provider";
import { OperationalLogger } from "./core/services/operational-logger";

export function buildApp() {
  const settings = loadSettings();
  const traceSink = new InMemoryTraceSink();
  const logger = new OperationalLogger(settings);
  const orchestrator = new TurnOrchestrator({
    settings,
    stateStore: new InMemoryStateStore(),
    memoryProvider: new InMemoryMemoryProvider(),
    knowledgeProvider: new NoopKnowledgeProvider(),
    llmProvider: new GenericLlmProvider(),
    dspyBridge: new HttpDspyBridge(settings.dspy),
    traceSink,
    outboundTransport: new NoopTransport(),
    logger
  });

  return new Elysia()
    .get("/health", async () => ({
      ok: true,
      service: settings.app.name,
      dspyEnabled: settings.dspy.enabled,
      timestamp: new Date().toISOString()
    }))
    .post("/webhooks/messages", async ({ body, set }) => {
      try {
        const inbound = normalizeInboundMessage(body as Record<string, unknown>);
        void orchestrator.processTurn(inbound).catch((error) => {
          void logger.logSystemError("async_turn", "http.webhooks.messages", error, {
            session_id: inbound.sessionId,
            correlation_id: inbound.correlationId ?? inbound.sessionId
          });
        });
        set.status = 202;
        return {
          accepted: true,
          mode: "async",
          sessionId: inbound.sessionId
        };
      } catch (error) {
        await logger.logSystemError("normalize_inbound", "http.webhooks.messages", error);
        set.status = 400;
        return {
          accepted: false,
          error: error instanceof Error ? error.message : "unknown_error"
        };
      }
    })
    .post("/turns/execute", async ({ body, set }) => {
      try {
        const inbound = normalizeInboundMessage(body as Record<string, unknown>);
        const outcome = await orchestrator.processTurn(inbound);
        return {
          accepted: true,
          mode: "sync",
          outcome
        };
      } catch (error) {
        await logger.logSystemError("sync_turn", "http.turns.execute", error);
        set.status = 400;
        return {
          accepted: false,
          error: error instanceof Error ? error.message : "unknown_error"
        };
      }
    })
    .get("/debug/traces", () => traceSink.getSnapshot());
}
