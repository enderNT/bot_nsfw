import type { AppSettings } from "../config";
import type {
  CapabilityResult,
  ExecutionContext,
  InboundMessage,
  RouteDecision,
  ShortTermState,
  TurnOutcome
} from "../domain/contracts";
import type {
  DspyBridge,
  KnowledgeProvider,
  LlmProvider,
  MemoryProvider,
  OutboundTransport,
  StateStore,
  TraceSink
} from "../domain/ports";
import { runActionCapability } from "./capabilities/action";
import { runConversationCapability } from "./capabilities/conversation";
import { runKnowledgeCapability } from "./capabilities/knowledge";
import { buildPromptMemorySelection } from "./services/memory-selection";
import { appendTurn, mergeState } from "./utils/state";

interface OrchestratorDependencies {
  settings: AppSettings;
  stateStore: StateStore;
  memoryProvider: MemoryProvider;
  knowledgeProvider: KnowledgeProvider;
  llmProvider: LlmProvider;
  dspyBridge: DspyBridge;
  traceSink: TraceSink;
  outboundTransport: OutboundTransport;
}

export class TurnOrchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  async processTurn(inbound: InboundMessage): Promise<TurnOutcome> {
    const traceId = await this.deps.traceSink.startTurn(inbound);

    try {
      await this.deps.traceSink.append(traceId, "ingest", inbound);

      let state = await this.deps.stateStore.load(inbound.sessionId);
      state = appendTurn(
        state,
        { role: "user", text: inbound.text, timestamp: inbound.receivedAt },
        this.deps.settings.prompt.recentTurnsLimit
      );

      const recalledMemories = this.deps.settings.memory.enabled
        ? await this.deps.memoryProvider.search(
            inbound.text,
            inbound.actorId,
            this.deps.settings.memory.agentId,
            this.deps.settings.memory.topK,
            this.deps.settings.memory.scoreThreshold
          )
        : [];
      const memorySelection = await buildPromptMemorySelection(
        inbound.text,
        recalledMemories,
        this.deps.llmProvider,
        this.deps.settings.prompt
      );
      await this.deps.traceSink.append(traceId, "load_context", {
        shortTermState: state,
        rawRecall: memorySelection.rawRecall,
        promptDigest: memorySelection.promptDigest
      });

      const routeDecision = await this.decideRoute(inbound, state, memorySelection.promptDigest, traceId);
      const knowledge = this.deps.settings.knowledge.enabled && routeDecision.needsKnowledge
        ? await this.deps.knowledgeProvider.retrieve(inbound.text, this.deps.settings.knowledge.topK)
        : [];

      const context: ExecutionContext = {
        inbound,
        shortTermState: state,
        memorySelection,
        knowledge,
        routeDecision,
        traceId
      };

      const { result, usedDspy } = await this.executeCapability(context);
      await this.deps.traceSink.append(traceId, "execute_capability", {
        capability: routeDecision.capability,
        result,
        usedDspy
      });

      const updatedState = await this.finalizeState(state, routeDecision, result, inbound.text);
      const outcome: TurnOutcome = {
        capability: routeDecision.capability,
        intent: routeDecision.intent,
        confidence: routeDecision.confidence,
        responseText: result.responseText,
        handoffRequired: result.handoffRequired,
        stateSnapshot: updatedState,
        artifacts: {
          ...result.artifacts,
          knowledgeCount: knowledge.length,
          usedDspy
        }
      };

      await this.persist(inbound, updatedState, result);
      await this.deps.traceSink.projectReply(traceId, outcome, inbound);
      await this.deps.traceSink.endTurn(traceId, outcome);
      await this.deps.outboundTransport.emit(outcome, inbound);

      return outcome;
    } catch (error) {
      await this.deps.traceSink.failTurn(traceId, error);
      throw error;
    }
  }

  private async decideRoute(
    inbound: InboundMessage,
    state: ShortTermState,
    promptDigest: string,
    traceId: string
  ): Promise<RouteDecision> {
    const dspyDecision = await this.deps.dspyBridge.predictRouteDecision?.({ inbound, state, promptDigest });
    const decision = dspyDecision ?? (await this.deps.llmProvider.decideRoute({ inbound, state, promptDigest }));
    await this.deps.traceSink.projectRouteDecision(traceId, decision);
    await this.deps.traceSink.append(traceId, "route", decision);
    return decision;
  }

  private async executeCapability(context: ExecutionContext): Promise<{ result: CapabilityResult; usedDspy: boolean }> {
    switch (context.routeDecision.capability) {
      case "knowledge":
        return runKnowledgeCapability(context, this.deps.llmProvider, this.deps.dspyBridge);
      case "action":
        return runActionCapability(context, this.deps.llmProvider, this.deps.dspyBridge);
      default:
        return runConversationCapability(context, this.deps.llmProvider, this.deps.dspyBridge);
    }
  }

  private async finalizeState(
    state: ShortTermState,
    routeDecision: RouteDecision,
    result: CapabilityResult,
    userText: string
  ): Promise<ShortTermState> {
    const withDecision = mergeState(state, routeDecision.statePatch);
    const withResult = mergeState(withDecision, result.statePatch);
    const withAssistantTurn = appendTurn(
      withResult,
      { role: "assistant", text: result.responseText, timestamp: new Date().toISOString() },
      this.deps.settings.prompt.recentTurnsLimit
    );

    const shouldRefreshSummary =
      withAssistantTurn.turnCount % this.deps.settings.state.refreshTurnThreshold === 0 ||
      withAssistantTurn.summary.length >= this.deps.settings.state.refreshCharThreshold ||
      withAssistantTurn.summary.length === 0;

    if (!shouldRefreshSummary) {
      return withAssistantTurn;
    }

    return {
      ...withAssistantTurn,
      summary: await this.deps.llmProvider.summarizeState({
        state: withAssistantTurn,
        recentUserText: userText
      })
    };
  }

  private async persist(inbound: InboundMessage, state: ShortTermState, result: CapabilityResult): Promise<void> {
    await this.deps.stateStore.save(inbound.sessionId, state);

    if (!this.deps.settings.memory.enabled) {
      return;
    }

    await this.deps.memoryProvider.addTurn(
      [
        { role: "user", text: inbound.text, timestamp: inbound.receivedAt },
        { role: "assistant", text: result.responseText, timestamp: new Date().toISOString() }
      ],
      inbound.actorId,
      this.deps.settings.memory.agentId,
      inbound.sessionId,
      {
        channel: inbound.channel,
        capability: state.lastCapability,
        lastIntent: state.lastIntent
      }
    );
  }
}
