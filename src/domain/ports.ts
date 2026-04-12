import type {
  AddMemoryResult,
  Capability,
  CapabilityResult,
  ExecutionContext,
  InboundMessage,
  KnowledgeDocument,
  MemoryHit,
  PromptMemorySelection,
  RouteDecision,
  ShortTermState,
  TurnOutcome,
  TurnRecord
} from "./contracts";

export interface MemoryProvider {
  addTurn(messages: TurnRecord[], actorId: string, agentId: string, sessionId: string, metadata: Record<string, unknown>): Promise<AddMemoryResult>;
  search(query: string, actorId: string, agentId: string, topK: number, threshold: number): Promise<MemoryHit[]>;
}

export interface KnowledgeProvider {
  retrieve(query: string, topK: number): Promise<KnowledgeDocument[]>;
}

export interface LlmProvider {
  decideRoute(input: {
    inbound: InboundMessage;
    state: ShortTermState;
    promptDigest: string;
  }): Promise<RouteDecision>;
  generateReply(capability: Capability, context: ExecutionContext): Promise<CapabilityResult>;
  summarizeState(input: { state: ShortTermState; recentUserText: string }): Promise<string>;
  summarizeMemories(input: { query: string; memories: MemoryHit[]; budgetChars: number }): Promise<string>;
}

export interface DspyBridge {
  health(): Promise<boolean>;
  predictRouteDecision?(payload: {
    inbound: InboundMessage;
    state: ShortTermState;
    promptDigest: string;
  }): Promise<RouteDecision | null>;
  predictReply?(capability: Capability, context: ExecutionContext): Promise<CapabilityResult | null>;
}

export interface TraceSink {
  startTurn(inbound: InboundMessage): Promise<string>;
  append(traceId: string, event: string, payload: unknown): Promise<void>;
  projectRouteDecision(traceId: string, decision: RouteDecision): Promise<void>;
  projectReply(traceId: string, outcome: TurnOutcome, inbound: InboundMessage): Promise<void>;
  endTurn(traceId: string, outcome: TurnOutcome): Promise<void>;
  failTurn(traceId: string, error: unknown): Promise<void>;
}

export interface OutboundTransport {
  emit(outcome: TurnOutcome, inbound: InboundMessage): Promise<void>;
}

export interface StateStore {
  load(sessionId: string): Promise<ShortTermState>;
  save(sessionId: string, state: ShortTermState): Promise<void>;
}
