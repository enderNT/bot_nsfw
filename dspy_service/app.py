from fastapi import FastAPI
from pydantic import BaseModel


class RouteDecision(BaseModel):
    capability: str
    intent: str
    confidence: float
    needsKnowledge: bool
    statePatch: dict
    reason: str


class CapabilityResult(BaseModel):
    responseText: str
    statePatch: dict | None = None
    handoffRequired: bool
    artifacts: dict
    memoryHints: list[str]


app = FastAPI(title="generic-dspy-bridge", version="0.1.0")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/predict/route-decision", response_model=RouteDecision)
def predict_route_decision(payload: dict):
    text = str(payload.get("inbound", {}).get("text", "")).lower()
    if any(token in text for token in ["buscar", "documentacion", "documentación", "informacion", "información"]):
        capability = "knowledge"
        intent = "knowledge_lookup"
    elif any(token in text for token in ["crea", "actualiza", "programa", "agenda", "ejecuta"]):
        capability = "action"
        intent = "workflow_progress"
    else:
        capability = "conversation"
        intent = "general_conversation"

    return RouteDecision(
        capability=capability,
        intent=intent,
        confidence=0.81,
        needsKnowledge=capability == "knowledge",
        statePatch={"lastCapability": capability, "lastIntent": intent},
        reason="Fallback heuristico del bridge Python."
    )


@app.post("/predict/conversation-reply", response_model=CapabilityResult)
def predict_conversation_reply(payload: dict):
    text = str(payload.get("inbound", {}).get("text", ""))
    return CapabilityResult(
        responseText=f"Respuesta generica de conversacion desde el servicio Python. Mensaje: {text}",
        statePatch={"stage": "conversation"},
        handoffRequired=False,
        artifacts={"provider": "python-dspy-service", "capability": "conversation"},
        memoryHints=[text]
    )


@app.post("/predict/knowledge-reply", response_model=CapabilityResult)
def predict_knowledge_reply(payload: dict):
    text = str(payload.get("inbound", {}).get("text", ""))
    knowledge = payload.get("knowledge", [])
    knowledge_snippet = " | ".join(item.get("content", "") for item in knowledge if isinstance(item, dict))
    return CapabilityResult(
        responseText=f"Respuesta de conocimiento generica desde Python. Consulta: {text}. Contexto: {knowledge_snippet}",
        statePatch={"stage": "knowledge"},
        handoffRequired=False,
        artifacts={"provider": "python-dspy-service", "capability": "knowledge"},
        memoryHints=[text]
    )


@app.post("/predict/action-reply", response_model=CapabilityResult)
def predict_action_reply(payload: dict):
    text = str(payload.get("inbound", {}).get("text", ""))
    return CapabilityResult(
        responseText=f"Respuesta de accion generica desde Python. Solicitud: {text}",
        statePatch={"stage": "action", "pendingAction": "awaiting_follow_up"},
        handoffRequired=False,
        artifacts={"provider": "python-dspy-service", "capability": "action"},
        memoryHints=[text]
    )
