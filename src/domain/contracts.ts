export type Capability = "conversation" | "knowledge" | "action";

export interface InboundMessage {
  sessionId: string;
  actorId: string;
  channel: string;
  text: string;
  accountId?: string;
  contactName?: string;
  rawPayload: unknown;
  receivedAt: string;
}

export interface RouteDecision {
  capability: Capability;
  intent: string;
  confidence: number;
  needsKnowledge: boolean;
  statePatch: Partial<ShortTermState>;
  reason: string;
}

export interface CapabilityResult {
  responseText: string;
  statePatch?: Partial<ShortTermState>;
  handoffRequired: boolean;
  artifacts: Record<string, unknown>;
  memoryHints: string[];
}

export interface TurnOutcome {
  capability: Capability;
  intent: string;
  confidence: number;
  responseText: string;
  handoffRequired: boolean;
  stateSnapshot: ShortTermState;
  artifacts: Record<string, unknown>;
}

export interface TurnRecord {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface ShortTermState {
  summary: string;
  recentTurns: TurnRecord[];
  activeGoal?: string;
  stage?: string;
  pendingAction?: string;
  lastCapability?: Capability;
  lastIntent?: string;
  continuitySignals: string[];
  turnCount: number;
}

export interface MemoryHit {
  id: string;
  memory: string;
  score: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AddMemoryResult {
  stored: boolean;
  count: number;
}

export interface KnowledgeDocument {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface PromptMemorySelection {
  rawRecall: MemoryHit[];
  promptDigest: string;
}

export interface ExecutionContext {
  inbound: InboundMessage;
  shortTermState: ShortTermState;
  memorySelection: PromptMemorySelection;
  knowledge: KnowledgeDocument[];
  routeDecision: RouteDecision;
  traceId: string;
}

export interface RouteTraceDataset {
  traceId: string;
  capability: Capability;
  intent: string;
  confidence: number;
  reason: string;
}

export interface ReplyTraceDataset {
  traceId: string;
  capability: Capability;
  inputText: string;
  responseText: string;
}
