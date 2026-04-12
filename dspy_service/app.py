from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from langgraph_workflow import (
    build_capability_result,
    build_route_decision,
    run_reply_graph,
    run_route_graph,
)


class RouteDecision(BaseModel):
    capability: str
    intent: str
    confidence: float
    needsKnowledge: bool
    statePatch: dict[str, Any]
    reason: str


class CapabilityResult(BaseModel):
    responseText: str
    statePatch: dict[str, Any] | None = None
    handoffRequired: bool
    artifacts: dict[str, Any]
    memoryHints: list[str]


app = FastAPI(title="generic-langgraph-bridge", version="0.2.0")


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "langgraph",
        "routes": ["conversation", "rag"],
    }


@app.post("/predict/route-decision", response_model=RouteDecision)
def predict_route_decision(payload: dict[str, Any]):
    state = run_route_graph(payload)
    return RouteDecision(**build_route_decision(state))


@app.post("/predict/conversation-reply", response_model=CapabilityResult)
def predict_conversation_reply(payload: dict[str, Any]):
    state = run_reply_graph(payload, forced_route="conversation")
    return CapabilityResult(**build_capability_result(state))


@app.post("/predict/knowledge-reply", response_model=CapabilityResult)
def predict_knowledge_reply(payload: dict[str, Any]):
    state = run_reply_graph(payload, forced_route="rag")
    return CapabilityResult(**build_capability_result(state))


@app.post("/predict/action-reply", response_model=CapabilityResult)
def predict_action_reply(payload: dict[str, Any]):
    text = str(payload.get("inbound", {}).get("text", ""))
    return CapabilityResult(
        responseText=f"Accion fuera del grafo LangGraph actual. Solicitud: {text}",
        statePatch={"stage": "action", "pendingAction": "awaiting_follow_up"},
        handoffRequired=False,
        artifacts={
            "provider": "python-langgraph-service",
            "capability": "action",
            "graphEnabled": False,
        },
        memoryHints=[text] if text else [],
    )
