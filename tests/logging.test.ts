import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppSettings } from "../src/config";
import { OperationalLogger } from "../src/core/services/operational-logger";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function buildSettings(directory: string, overrides?: Partial<AppSettings["logging"]>): AppSettings {
  return {
    app: {
      env: "development",
      name: "test-app",
      host: "0.0.0.0",
      port: 3000,
      logLevel: "INFO",
      locale: "es-MX",
      timezone: "America/Mexico_City"
    },
    logging: {
      consoleEnabled: false,
      fileEnabled: true,
      directory,
      fileName: "app.log",
      maxFiles: 2,
      maxLinesPerFile: 6,
      instanceId: "",
      containerName: "",
      containerId: "",
      hostName: "test-host",
      ...overrides
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
}

describe("OperationalLogger rotation", () => {
  it("keeps a bounded set of log files and line counts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bot-nsfw-logs-"));
    tempDirs.push(directory);

    const logger = new OperationalLogger(buildSettings(directory));

    await logger.logStartup({ boot: 1 });
    await logger.logStartup({ boot: 2 });
    await logger.logStartup({ boot: 3 });

    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["app.1.log", "app.log"]);

    for (const file of files) {
      const content = await readFile(join(directory, file), "utf8");
      const lineCount = content.trimEnd().split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(6);
    }

    const latestContent = await readFile(join(directory, "app.log"), "utf8");
    expect(latestContent).toContain("boot: 3");
  });

  it("writes memory read and write blocks to the operational log file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bot-nsfw-memory-logs-"));
    tempDirs.push(directory);

    const logger = new OperationalLogger(buildSettings(directory, { maxFiles: 3, maxLinesPerFile: 50 }));
    const execution = await logger.startRun({
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "hola",
      rawPayload: {},
      receivedAt: "2026-04-13T00:00:00.000Z"
    });

    await execution.memoryRead("short_term_state", {
      scope: "short_term",
      component: "state_store",
      request: { sessionId: "session-1" },
      response: { turnCount: 1, summaryPreview: "Resumen corto" },
      status: "ok"
    });
    await execution.memoryWrite("long_term_memory", {
      scope: "long_term",
      component: "in_memory",
      request: { sessionId: "session-1" },
      response: { stored: true, count: 1 },
      status: "ok"
    });
    await execution.end({ status: "ok", summary: "test", result: "completed" });

    const content = await readFile(join(directory, "app.log"), "utf8");
    expect(content).toContain("[02.MEMORY.READ.short_term_state]");
    expect(content).toContain("[07.MEMORY.WRITE.long_term_memory]");
    expect(content).toContain("\"scope\": \"short_term\"");
    expect(content).toContain("\"scope\": \"long_term\"");
  });
});
