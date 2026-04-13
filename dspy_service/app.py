from __future__ import annotations

from fastapi import FastAPI, HTTPException

from contracts import (
    CapabilityResult,
    ExecutionContext,
    OptimizeRequest,
    RouteDecision,
    RouteDecisionPayload,
)
from runtime import DspyRuntime


runtime = DspyRuntime()
app = FastAPI(title="generic-dspy-bridge", version="0.2.0")


@app.get("/health")
def health():
    return runtime.health()


@app.post("/predict/route-decision", response_model=RouteDecision)
def predict_route_decision(payload: RouteDecisionPayload):
    return runtime.predict_route_decision(payload)


@app.post("/predict/conversation-reply", response_model=CapabilityResult)
def predict_conversation_reply(payload: ExecutionContext):
    return runtime.predict_conversation(payload)


@app.post("/predict/knowledge-reply", response_model=CapabilityResult)
def predict_knowledge_reply(payload: ExecutionContext):
    return runtime.predict_knowledge(payload)


@app.post("/predict/action-reply", response_model=CapabilityResult)
def predict_action_reply(payload: ExecutionContext):
    return runtime.predict_action(payload)


@app.post("/optimize")
def optimize(payload: OptimizeRequest):
    try:
        return runtime.optimize(payload)
    except (RuntimeError, ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - runtime safety
        raise HTTPException(status_code=500, detail=str(exc)) from exc
