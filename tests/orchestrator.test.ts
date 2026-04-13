import { describe, expect, it } from "bun:test";
import { TurnOrchestrator } from "../src/core/orchestrator";
import { GenericLlmProvider } from "../src/core/services/generic-llm-provider";
import { HttpDspyBridge } from "../src/core/services/http-dspy-bridge";
import { InMemoryMemoryProvider } from "../src/core/services/in-memory-memory-provider";
import { InMemoryStateStore } from "../src/core/services/in-memory-state-store";
import { InMemoryTraceSink } from "../src/core/services/in-memory-trace-sink";
import { LangGraphCapabilityGraph } from "../src/core/services/langgraph-capability-graph";
import { NoopKnowledgeProvider } from "../src/core/services/noop-knowledge-provider";
import { OperationalLogger } from "../src/core/services/operational-logger";
import type { AppSettings } from "../src/config";

const settings: AppSettings = {
  app: { env: "test", name: "test-app", host: "0.0.0.0", port: 3000, logLevel: "INFO", locale: "es-MX", timezone: "America/Mexico_City" },
  logging: {
    consoleEnabled: false,
    fileEnabled: false,
    directory: "./tmp-test-logs",
    fileName: "app.log",
    maxFiles: 3,
    maxLinesPerFile: 200,
    instanceId: "",
    containerName: "",
    containerId: "",
    hostName: "test-host"
  },
  llm: { provider: "test", model: "test-model", timeoutMs: 1000 },
  router: { confidenceThreshold: 0.62, knowledgeThreshold: 0.58 },
  prompt: { memoryMaxItems: 3, memoryBudgetChars: 1200, recentTurnsLimit: 4, summarizeOnOverflow: true },
  state: { refreshTurnThreshold: 2, refreshCharThreshold: 900 },
  memory: {
    provider: "in_memory",
    enabled: true,
    agentId: "test-agent",
    topK: 5,
    scoreThreshold: 0,
    infer: true,
    customInstructionsVersion: "v1",
    mem0: {
      apiKey: "",
      baseUrl: "http://127.0.0.1:8000",
      orgId: "",
      projectId: ""
    }
  },
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

describe("TurnOrchestrator", () => {
  it("processes a generic conversation turn and persists continuity", async () => {
    const knowledgeProvider = new NoopKnowledgeProvider();
    const llmProvider = new GenericLlmProvider(settings.llm);
    const dspyBridge = new HttpDspyBridge(settings.dspy);
    const orchestrator = new TurnOrchestrator({
      settings,
      stateStore: new InMemoryStateStore(),
      memoryProvider: new InMemoryMemoryProvider(),
      knowledgeProvider,
      llmProvider,
      dspyBridge,
      traceSink: new InMemoryTraceSink(),
      outboundTransport: { emit: async () => undefined },
      logger: new OperationalLogger(settings),
      langGraph: new LangGraphCapabilityGraph({
        settings,
        knowledgeProvider,
        llmProvider,
        dspyBridge
      })
    });

    const firstOutcome = await orchestrator.processTurn({
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "Hola, me llamo Gabriel y quiero probar el bot base.",
      rawPayload: {},
      receivedAt: new Date().toISOString()
    });

    const secondOutcome = await orchestrator.processTurn({
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "Recuerdas cómo me llamo?",
      rawPayload: {},
      receivedAt: new Date().toISOString()
    });

    expect(firstOutcome.capability).toBe("conversation");
    expect(secondOutcome.stateSnapshot.recentTurns.length).toBeGreaterThan(1);
    expect(secondOutcome.responseText).toContain("Memoria útil");
  });
});
