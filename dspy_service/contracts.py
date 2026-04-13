from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


Capability = Literal["conversation", "knowledge", "action"]
DspyTarget = Literal["route_decision", "conversation"]


class FlexibleModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class InboundMessage(FlexibleModel):
    sessionId: str = ""
    actorId: str = ""
    channel: str = "generic"
    text: str = ""
    correlationId: str | None = None
    parentRunId: str | None = None
    trigger: str | None = None
    accountId: str | None = None
    contactName: str | None = None
    rawPayload: Any = None
    receivedAt: str = ""


class ShortTermState(FlexibleModel):
    summary: str = ""
    recentTurns: list[dict[str, Any]] = Field(default_factory=list)
    activeGoal: str | None = None
    stage: str | None = None
    pendingAction: str | None = None
    lastCapability: Capability | None = None
    lastIntent: str | None = None
    continuitySignals: list[str] = Field(default_factory=list)
    turnCount: int = 0


class PromptMemorySelection(FlexibleModel):
    rawRecall: list[dict[str, Any]] = Field(default_factory=list)
    promptDigest: str = ""


class KnowledgeDocument(FlexibleModel):
    id: str = ""
    content: str = ""
    score: float = 0.0
    metadata: dict[str, Any] = Field(default_factory=dict)


class RouteDecision(FlexibleModel):
    capability: Capability = "conversation"
    intent: str = "general_conversation"
    confidence: float = 0.0
    needsKnowledge: bool = False
    statePatch: dict[str, Any] = Field(default_factory=dict)
    reason: str = ""


class CapabilityResult(FlexibleModel):
    responseText: str = ""
    statePatch: dict[str, Any] | None = None
    handoffRequired: bool = False
    artifacts: dict[str, Any] = Field(default_factory=dict)
    memoryHints: list[str] = Field(default_factory=list)


class RouteDecisionPayload(FlexibleModel):
    inbound: InboundMessage = Field(default_factory=InboundMessage)
    state: ShortTermState = Field(default_factory=ShortTermState)
    promptDigest: str = ""


class ExecutionContext(FlexibleModel):
    inbound: InboundMessage = Field(default_factory=InboundMessage)
    shortTermState: ShortTermState = Field(default_factory=ShortTermState)
    memorySelection: PromptMemorySelection = Field(default_factory=PromptMemorySelection)
    knowledge: list[KnowledgeDocument] = Field(default_factory=list)
    routeDecision: RouteDecision = Field(default_factory=RouteDecision)
    traceId: str = ""


class OptimizeRequest(FlexibleModel):
    target: DspyTarget
    trainsetPath: str | None = None
    valsetPath: str | None = None
    trainset: list[dict[str, Any]] | None = None
    valset: list[dict[str, Any]] | None = None
    auto: Literal["light", "medium", "heavy"] = "light"
    maxBootstrappedDemos: int = 2
    maxLabeledDemos: int = 2
    numThreads: int = 4
    seed: int = 9
    save: bool = True

