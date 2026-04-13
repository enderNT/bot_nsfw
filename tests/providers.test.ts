import { afterEach, describe, expect, it } from "bun:test";
import { GenericLlmProvider } from "../src/core/services/generic-llm-provider";
import { Mem0MemoryProvider } from "../src/core/services/mem0-memory-provider";
import type { AppSettings } from "../src/config";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GenericLlmProvider remote mode", () => {
  it("calls an OpenAI-compatible chat completions endpoint for route decisions", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  capability: "knowledge",
                  intent: "knowledge_lookup",
                  confidence: 0.91,
                  needsKnowledge: true,
                  reason: "remote router",
                  statePatch: {
                    lastCapability: "knowledge",
                    lastIntent: "knowledge_lookup"
                  }
                })
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch;

    const provider = new GenericLlmProvider({
      provider: "openai_compatible",
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      timeoutMs: 1_000
    });

    const decision = await provider.decideRoute({
      inbound: { text: "Busca la documentación de la API" },
      state: {
        summary: "",
        recentTurns: [],
        continuitySignals: [],
        turnCount: 1
      },
      promptDigest: "consulta de documentacion"
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(decision.capability).toBe("knowledge");
    expect(decision.intent).toBe("knowledge_lookup");
    expect(decision.reason).toBe("remote router");

    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
  });
});

describe("Mem0MemoryProvider", () => {
  it("adds and searches memories through Mem0 platform endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let callCount = 0;

    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init });
      callCount += 1;

      if (callCount === 1) {
        return new Response(
          JSON.stringify([
            {
              id: "mem_evt_1",
              event: "ADD",
              data: { memory: "El usuario prefiere respuestas breves." }
            }
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(
        JSON.stringify({
          results: [
            {
              id: "mem_1",
              memory: "El usuario prefiere respuestas breves.",
              score: 0.88,
              metadata: { source: "unit-test" },
              created_at: "2026-04-12T00:00:00.000Z",
              updated_at: "2026-04-12T00:00:00.000Z"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch;

    const memorySettings: AppSettings["memory"] = {
      provider: "mem0",
      enabled: true,
      agentId: "agent-1",
      topK: 5,
      scoreThreshold: 0,
      infer: true,
      customInstructionsVersion: "v1",
      mem0: {
        apiKey: "mem0-key",
        baseUrl: "https://api.mem0.ai",
        orgId: "",
        projectId: ""
      }
    };

    const provider = new Mem0MemoryProvider(memorySettings);

    const addResult = await provider.addTurn(
      [
        { role: "user", text: "Prefiero respuestas breves.", timestamp: "2026-04-12T00:00:00.000Z" },
        { role: "assistant", text: "Anotado.", timestamp: "2026-04-12T00:00:01.000Z" }
      ],
      "user-1",
      "agent-1",
      "session-1",
      { source: "unit-test" }
    );

    const searchResult = await provider.search("Como debo responderle?", "user-1", "agent-1", 5, 0.1);

    expect(addResult).toEqual({ stored: true, count: 1 });
    expect(searchResult).toHaveLength(1);
    expect(searchResult[0]?.memory).toBe("El usuario prefiere respuestas breves.");
    expect(requests[0]?.url).toBe("https://api.mem0.ai/v1/memories/");
    expect(requests[1]?.url).toBe("https://api.mem0.ai/v2/memories/search");

    const addHeaders = requests[0]?.init?.headers as Record<string, string>;
    expect(addHeaders.Authorization).toBe("Token mem0-key");
  });
});
