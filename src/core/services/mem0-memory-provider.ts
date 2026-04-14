import type { AppSettings } from "../../config";
import type { AddMemoryResult, MemoryHit, TurnRecord } from "../../domain/contracts";
import type { MemoryProvider } from "../../domain/ports";

interface Mem0PlatformAddEvent {
  id?: string;
  event?: string;
  data?: {
    memory?: string;
  };
}

interface Mem0SearchResult {
  id?: string;
  memory?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  data?: {
    memory?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isPlatformMem0(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname.includes("api.mem0.ai") || /^\/v[12]\b/.test(url.pathname);
  } catch {
    return false;
  }
}

function buildHeaders(baseUrl: string, apiKey?: string): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json"
  };

  if (!apiKey) {
    return headers;
  }

  if (isPlatformMem0(baseUrl)) {
    headers.Authorization = `Token ${apiKey}`;
    return headers;
  }

  headers["X-API-Key"] = apiKey;
  return headers;
}

function toSearchResults(payload: unknown): Mem0SearchResult[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord) as Mem0SearchResult[];
  }

  if (isRecord(payload) && Array.isArray(payload.results)) {
    return payload.results.filter(isRecord) as Mem0SearchResult[];
  }

  return [];
}

export class Mem0MemoryProvider implements MemoryProvider {
  private readonly baseUrl: string;
  private readonly headers: HeadersInit;
  private readonly platformMode: boolean;

  constructor(private readonly settings: AppSettings["memory"]) {
    this.baseUrl = normalizeBaseUrl(settings.mem0.baseUrl);
    this.headers = buildHeaders(this.baseUrl, settings.mem0.apiKey);
    this.platformMode = isPlatformMem0(this.baseUrl);
  }

  async addTurn(
    messages: TurnRecord[],
    actorId: string,
    agentId: string,
    sessionId: string,
    metadata: Record<string, unknown>
  ): Promise<AddMemoryResult> {
    const payload = {
      messages: messages.map((message) => ({
        role: message.role,
        content: message.text
      })),
      user_id: actorId,
      agent_id: agentId,
      run_id: sessionId,
      infer: this.settings.infer,
      metadata: {
        ...metadata,
        sessionId,
        customInstructionsVersion: this.settings.customInstructionsVersion
      },
      ...(this.platformMode
        ? {
            org_id: this.settings.mem0.orgId || undefined,
            project_id: this.settings.mem0.projectId || undefined
          }
        : {})
    };

    const response = await fetch(this.resolveUrl("add"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Mem0 add failed: ${response.status} ${await response.text()}`);
    }

    const responsePayload = (await response.json()) as unknown;
    const events = Array.isArray(responsePayload)
      ? responsePayload.filter(isRecord)
      : isRecord(responsePayload) && Array.isArray(responsePayload.results)
        ? responsePayload.results.filter(isRecord)
        : [];

    return {
      stored: events.length > 0,
      count: events.length
    };
  }

  async search(
    query: string,
    actorId: string,
    agentId: string,
    topK: number,
    threshold: number
  ): Promise<MemoryHit[]> {
    const body = this.platformMode
      ? {
          query,
          version: "v2",
          top_k: topK,
          threshold,
          filters: {
            AND: [{ user_id: actorId }, { agent_id: agentId }]
          },
          ...(this.settings.mem0.orgId ? { org_id: this.settings.mem0.orgId } : {}),
          ...(this.settings.mem0.projectId ? { project_id: this.settings.mem0.projectId } : {})
        }
      : {
          query,
          user_id: actorId,
          agent_id: agentId,
          top_k: topK
        };

    const response = await fetch(this.resolveUrl("search"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Mem0 search failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as unknown;
    return toSearchResults(payload)
      .map((memory) => ({
        id: String(memory.id ?? crypto.randomUUID()),
        memory: String(memory.memory ?? memory.data?.memory ?? ""),
        score: Number.isFinite(memory.score) ? Number(memory.score) : 0,
        metadata: isRecord(memory.metadata) ? memory.metadata : {},
        createdAt: String(memory.created_at ?? new Date().toISOString()),
        updatedAt: String(memory.updated_at ?? memory.created_at ?? new Date().toISOString())
      }))
      .filter((memory) => memory.memory.length > 0 && memory.score >= threshold)
      .slice(0, topK);
  }

  private resolveUrl(operation: "add" | "search"): string {
    if (this.platformMode) {
      return operation === "add"
        ? `${this.baseUrl}/v1/memories/`
        : `${this.baseUrl}/v2/memories/search`;
    }

    return operation === "add" ? `${this.baseUrl}/memories` : `${this.baseUrl}/search`;
  }
}
