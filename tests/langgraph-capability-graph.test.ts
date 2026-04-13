import { describe, expect, it } from "bun:test";
import type { AppSettings } from "../src/config";
import type { ExecutionContext, RouteDecision, ShortTermState } from "../src/domain/contracts";
import { GenericLlmProvider } from "../src/core/services/generic-llm-provider";
import { HttpDspyBridge } from "../src/core/services/http-dspy-bridge";
import { LangGraphCapabilityGraph } from "../src/core/services/langgraph-capability-graph";
import { NoopKnowledgeProvider } from "../src/core/services/noop-knowledge-provider";

const settings: AppSettings = {
  app: { env: "test", name: "test-app", host: "0.0.0.0", port: 3000, logLevel: "INFO", locale: "es-MX", timezone: "America/Mexico_City" },
  logging: {
    consoleEnabled: false,
    fileEnabled: false,
    directory: "./tmp-test-logs",
    fileName: "app.log",
    instanceId: "",
    containerName: "",
    containerId: "",
    hostName: "test-host"
  },
  llm: { provider: "test", model: "test-model", timeoutMs: 1000 },
  router: { confidenceThreshold: 0.62, knowledgeThreshold: 0.58 },
  prompt: { memoryMaxItems: 3, memoryBudgetChars: 1200, recentTurnsLimit: 4, summarizeOnOverflow: true },
  state: { refreshTurnThreshold: 2, refreshCharThreshold: 900 },
  memory: { provider: "in_memory", enabled: true, agentId: "test-agent", topK: 5, scoreThreshold: 0 },
  knowledge: { provider: "none", enabled: false, topK: 3, timeoutMs: 1000 },
  channel: {
    provider: "none",
    replyEnabled: false,
    chatwoot: {
      baseUrl: "",
      apiAccessToken: ""
    }
  },
  trace: { backend: "in_memory", appKey: "test", projectorsEnabled: true, storeRawRecall: true, storePromptDigest: true },
  dspy: {
    enabled: false,
    serviceUrl: "http://localhost:8001",
    timeoutMs: 100,
    retryCount: 0,
    routeDecisionEnabled: false,
    conversationReplyEnabled: false,
    knowledgeReplyEnabled: false,
    actionReplyEnabled: false
  }
};

const shortTermState: ShortTermState = {
  summary: "",
  recentTurns: [],
  continuitySignals: [],
  turnCount: 0
};

function buildContext(routeDecision: RouteDecision): ExecutionContext {
  return {
    inbound: {
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "hola",
      rawPayload: {},
      receivedAt: new Date().toISOString()
    },
    shortTermState,
    memorySelection: {
      rawRecall: [],
      promptDigest: "usuario saluda"
    },
    knowledge: [],
    routeDecision,
    traceId: "trace-1"
  };
}

describe("LangGraphCapabilityGraph", () => {
  it("routes conversation capability through the conversation node", async () => {
    const graph = new LangGraphCapabilityGraph({
      settings,
      llmProvider: new GenericLlmProvider(),
      dspyBridge: new HttpDspyBridge(settings.dspy),
      knowledgeProvider: new NoopKnowledgeProvider()
    });

    const result = await graph.invoke(
      buildContext({
        capability: "conversation",
        intent: "general_conversation",
        confidence: 0.8,
        needsKnowledge: false,
        reason: "test",
        statePatch: {}
      })
    );

    expect(result.route).toBe("conversation");
    expect(result.result.responseText).toContain("Mantengo la conversación");
  });

  it("routes knowledge capability through the rag node", async () => {
    const graph = new LangGraphCapabilityGraph({
      settings,
      llmProvider: new GenericLlmProvider(),
      dspyBridge: new HttpDspyBridge(settings.dspy),
      knowledgeProvider: new NoopKnowledgeProvider()
    });

    const result = await graph.invoke(
      buildContext({
        capability: "knowledge",
        intent: "knowledge_lookup",
        confidence: 0.8,
        needsKnowledge: true,
        reason: "test",
        statePatch: {}
      })
    );

    expect(result.route).toBe("rag");
    expect(result.result.responseText).toContain("Comparto una respuesta basada en el contexto recuperado");
  });
});
