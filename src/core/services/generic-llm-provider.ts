import type { AppSettings } from "../../config";
import type {
  Capability,
  CapabilityResult,
  ExecutionContext,
  MemoryHit,
  RouteDecision,
  ShortTermState
} from "../../domain/contracts";
import type { LlmProvider } from "../../domain/ports";

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

const LOCAL_ONLY_PROVIDERS = new Set(["test", "heuristic", "mock", "stub", "local"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeStatePatch(value: unknown): Partial<ShortTermState> {
  if (!isRecord(value)) {
    return {};
  }

  const patch: Partial<ShortTermState> = {};
  if (typeof value.summary === "string") patch.summary = value.summary;
  if (typeof value.activeGoal === "string") patch.activeGoal = value.activeGoal;
  if (typeof value.stage === "string") patch.stage = value.stage;
  if (typeof value.pendingAction === "string") patch.pendingAction = value.pendingAction;
  if (typeof value.lastCapability === "string" && ["conversation", "knowledge", "action"].includes(value.lastCapability)) {
    patch.lastCapability = value.lastCapability as Capability;
  }
  if (typeof value.lastIntent === "string") patch.lastIntent = value.lastIntent;
  if (Array.isArray(value.continuitySignals)) {
    patch.continuitySignals = value.continuitySignals.filter((item): item is string => typeof item === "string");
  }
  if (typeof value.turnCount === "number" && Number.isFinite(value.turnCount)) {
    patch.turnCount = value.turnCount;
  }

  return patch;
}

function extractJsonPayload(raw: string): unknown {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? raw.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("LLM response did not contain valid JSON");
  }
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function resolveCompletionUrl(baseUrl?: string): string {
  const normalizedBaseUrl = (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  return normalizedBaseUrl.endsWith("/chat/completions")
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/chat/completions`;
}

function inferCapability(text: string): Capability {
  const lowerText = text.toLowerCase();
  if (/(buscar|qué es|que es|explica|información|informacion|dato|docs|documentación|documentacion|consulta)/i.test(lowerText)) {
    return "knowledge";
  }
  if (/(agenda|crea|actualiza|cancela|reserva|programa|haz|ejecuta|workflow|proceso|acción|accion)/i.test(lowerText)) {
    return "action";
  }
  return "conversation";
}

function inferIntent(text: string, capability: Capability): string {
  switch (capability) {
    case "knowledge":
      return "knowledge_lookup";
    case "action":
      return "workflow_progress";
    default:
      return text.trim().split(/\s+/).slice(0, 4).join("_").toLowerCase() || "general_conversation";
  }
}

function buildReplyPrefix(capability: Capability): string {
  switch (capability) {
    case "knowledge":
      return "Comparto una respuesta basada en el contexto recuperado";
    case "action":
      return "Te ayudo a avanzar el flujo solicitado";
    default:
      return "Mantengo la conversación con el contexto disponible";
  }
}

export class GenericLlmProvider implements LlmProvider {
  constructor(private readonly settings?: AppSettings["llm"]) {}

  async decideRoute(input: { inbound: { text: string }; state: ShortTermState; promptDigest: string }): Promise<RouteDecision> {
    const heuristicDecision = this.heuristicRouteDecision(input);
    if (!this.shouldUseRemoteModel()) {
      return heuristicDecision;
    }

    const raw = await this.completeText("route_decision", [
      {
        role: "system",
        content:
          "Eres un router para un asistente conversacional. Devuelve solo JSON con estas claves: capability, intent, confidence, needsKnowledge, reason, statePatch. capability debe ser conversation, knowledge o action."
      },
      {
        role: "user",
        content: JSON.stringify({
          inboundText: input.inbound.text,
          shortTermState: {
            summary: input.state.summary,
            turnCount: input.state.turnCount,
            activeGoal: input.state.activeGoal ?? null,
            stage: input.state.stage ?? null,
            lastCapability: input.state.lastCapability ?? null,
            lastIntent: input.state.lastIntent ?? null
          },
          promptDigest: input.promptDigest,
          routingRules: {
            conversation: "charla general, continuidad, small talk, seguimiento sin necesidad de retrieval",
            knowledge: "pregunta factual, explicacion, documentacion, consulta que requiere conocimiento",
            action: "peticion operativa, cambios, ejecucion de workflow, reserva, agenda, crear o actualizar algo"
          }
        })
      }
    ]);

    const parsed = extractJsonPayload(raw);
    if (!isRecord(parsed)) {
      return heuristicDecision;
    }

    const capability =
      typeof parsed.capability === "string" && ["conversation", "knowledge", "action"].includes(parsed.capability)
        ? (parsed.capability as Capability)
        : heuristicDecision.capability;

    return {
      capability,
      intent: typeof parsed.intent === "string" && parsed.intent.trim().length > 0 ? parsed.intent : heuristicDecision.intent,
      confidence: clampConfidence(parsed.confidence, heuristicDecision.confidence),
      needsKnowledge:
        typeof parsed.needsKnowledge === "boolean" ? parsed.needsKnowledge : capability === "knowledge",
      reason: typeof parsed.reason === "string" && parsed.reason.trim().length > 0 ? parsed.reason : heuristicDecision.reason,
      statePatch: {
        ...heuristicDecision.statePatch,
        ...sanitizeStatePatch(parsed.statePatch)
      }
    };
  }

  async generateReply(capability: Capability, context: ExecutionContext): Promise<CapabilityResult> {
    const heuristicResult = this.heuristicGenerateReply(capability, context);
    if (!this.shouldUseRemoteModel()) {
      return heuristicResult;
    }

    const raw = await this.completeText(`${capability}_reply`, [
      {
        role: "system",
        content:
          "Eres el motor de respuesta de un asistente conversacional en espanol. Devuelve solo JSON con las claves responseText, handoffRequired, memoryHints, statePatch y artifacts. responseText debe ser util, concreto y listo para enviar al usuario."
      },
      {
        role: "user",
        content: JSON.stringify({
          capability,
          inboundText: context.inbound.text,
          contactName: context.inbound.contactName ?? null,
          stateSummary: context.shortTermState.summary,
          recentTurns: context.shortTermState.recentTurns.slice(-4),
          memoryPromptDigest: context.memorySelection.promptDigest,
          retrievedKnowledge: context.knowledge.map((document) => ({
            id: document.id,
            content: document.content,
            score: document.score
          })),
          routeDecision: context.routeDecision
        })
      }
    ]);

    const parsed = extractJsonPayload(raw);
    if (!isRecord(parsed)) {
      return heuristicResult;
    }

    const memoryHints =
      Array.isArray(parsed.memoryHints) && parsed.memoryHints.length > 0
        ? parsed.memoryHints.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : heuristicResult.memoryHints;

    const artifacts = isRecord(parsed.artifacts) ? parsed.artifacts : {};

    return {
      responseText:
        typeof parsed.responseText === "string" && parsed.responseText.trim().length > 0
          ? parsed.responseText.trim()
          : heuristicResult.responseText,
      handoffRequired:
        typeof parsed.handoffRequired === "boolean" ? parsed.handoffRequired : heuristicResult.handoffRequired,
      artifacts: {
        ...heuristicResult.artifacts,
        ...artifacts,
        provider: this.settings?.provider ?? heuristicResult.artifacts.provider,
        model: this.settings?.model ?? heuristicResult.artifacts.model,
        mode: this.shouldUseRemoteModel() ? "remote_chat_completions" : "heuristic"
      },
      memoryHints,
      statePatch: {
        ...heuristicResult.statePatch,
        ...sanitizeStatePatch(parsed.statePatch)
      }
    };
  }

  async summarizeState(input: { state: ShortTermState; recentUserText: string }): Promise<string> {
    if (!this.shouldUseRemoteModel()) {
      return this.heuristicSummarizeState(input);
    }

    const summary = await this.completeText("summarize_state", [
      {
        role: "system",
        content:
          "Resume el estado conversacional en espanol de forma breve y operativa. Devuelve solo texto plano y no excedas 500 caracteres."
      },
      {
        role: "user",
        content: JSON.stringify({
          currentSummary: input.state.summary,
          recentTurns: input.state.recentTurns.slice(-6),
          recentUserText: input.recentUserText,
          continuitySignals: input.state.continuitySignals,
          activeGoal: input.state.activeGoal ?? null,
          stage: input.state.stage ?? null
        })
      }
    ]);

    return summary.slice(0, 500);
  }

  async summarizeMemories(input: { query: string; memories: MemoryHit[]; budgetChars: number }): Promise<string> {
    if (!this.shouldUseRemoteModel()) {
      return this.heuristicSummarizeMemories(input);
    }

    const summary = await this.completeText("summarize_memories", [
      {
        role: "system",
        content:
          "Resume recuerdos relevantes para un asistente. Devuelve solo texto plano, conservando hechos utiles para responder la consulta."
      },
      {
        role: "user",
        content: JSON.stringify({
          query: input.query,
          memories: input.memories.map((memory) => ({
            memory: memory.memory,
            score: memory.score,
            metadata: memory.metadata
          })),
          budgetChars: input.budgetChars
        })
      }
    ]);

    return summary.slice(0, input.budgetChars);
  }

  private heuristicRouteDecision(input: {
    inbound: { text: string };
    state: ShortTermState;
    promptDigest: string;
  }): RouteDecision {
    const capability = inferCapability(input.inbound.text);
    const inferredIntent = inferIntent(input.inbound.text, capability);

    return {
      capability,
      intent: inferredIntent,
      confidence: capability === "conversation" ? 0.72 : 0.78,
      needsKnowledge: capability === "knowledge",
      reason: `Heurística genérica basada en texto y continuidad (turnos=${input.state.turnCount}, memoryDigest=${input.promptDigest.length}).`,
      statePatch: {
        lastCapability: capability,
        lastIntent: inferredIntent,
        activeGoal: capability === "action" ? "complete_user_requested_flow" : input.state.activeGoal
      }
    };
  }

  private heuristicGenerateReply(capability: Capability, context: ExecutionContext): CapabilityResult {
    const knowledgeSnippet =
      capability === "knowledge" && context.knowledge.length > 0
        ? ` Fuentes recuperadas: ${context.knowledge.map((doc) => doc.content).join(" | ")}.`
        : "";

    const memorySnippet = context.memorySelection.promptDigest
      ? ` Memoria útil: ${context.memorySelection.promptDigest}.`
      : "";

    const continuitySnippet = context.shortTermState.summary
      ? ` Resumen del hilo: ${context.shortTermState.summary}.`
      : "";

    return {
      responseText: `${buildReplyPrefix(capability)}. Entendí: "${context.inbound.text}".${continuitySnippet}${memorySnippet}${knowledgeSnippet}`.trim(),
      handoffRequired: false,
      artifacts: {
        provider: "generic-llm-provider",
        capability,
        knowledgeCount: context.knowledge.length,
        model: this.settings?.model ?? "heuristic"
      },
      memoryHints: [context.inbound.text],
      statePatch: {
        stage: capability === "action" ? "awaiting_next_step" : context.shortTermState.stage,
        pendingAction: capability === "action" ? "user_confirmation_or_follow_up" : undefined,
        continuitySignals: Array.from(new Set([...context.shortTermState.continuitySignals, capability]))
      }
    };
  }

  private heuristicSummarizeState(input: { state: ShortTermState; recentUserText: string }): Promise<string> | string {
    const previous = input.state.summary ? `${input.state.summary} ` : "";
    return `${previous}Último mensaje del usuario: ${input.recentUserText}`.slice(0, 500);
  }

  private heuristicSummarizeMemories(input: { query: string; memories: MemoryHit[]; budgetChars: number }): Promise<string> | string {
    const joined = input.memories.map((memory) => memory.memory).join(" | ");
    const summary = `Consulta: ${input.query}. Recuerdos relevantes: ${joined}`;
    return summary.slice(0, input.budgetChars);
  }

  private shouldUseRemoteModel(): boolean {
    if (!this.settings) {
      return false;
    }

    return !LOCAL_ONLY_PROVIDERS.has(this.settings.provider.toLowerCase()) && Boolean(this.settings.apiKey || this.settings.baseUrl);
  }

  private async completeText(taskName: string, messages: ChatCompletionMessage[]): Promise<string> {
    if (!this.settings) {
      throw new Error(`LLM settings missing for remote task ${taskName}`);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.settings.timeoutMs);

    try {
      const response = await fetch(resolveCompletionUrl(this.settings.baseUrl), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.settings.model,
          messages,
          ...(typeof this.settings.temperature === "number" ? { temperature: this.settings.temperature } : {})
        })
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`LLM ${taskName} request failed: ${response.status} ${detail}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      if (payload.error?.message) {
        throw new Error(`LLM ${taskName} responded with error: ${payload.error.message}`);
      }

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim().length > 0) {
        return content.trim();
      }

      if (Array.isArray(content)) {
        const text = content
          .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
          .join("")
          .trim();
        if (text.length > 0) {
          return text;
        }
      }

      throw new Error(`LLM ${taskName} returned empty content`);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
