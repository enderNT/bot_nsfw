from __future__ import annotations

import re
from typing import Iterable

from contracts import CapabilityResult, ExecutionContext, RouteDecision, RouteDecisionPayload


def infer_capability(text: str) -> str:
    lowered = text.lower()
    if any(token in lowered for token in ("buscar", "documentacion", "documentación", "informacion", "información", "docs", "explica")):
        return "knowledge"
    if any(token in lowered for token in ("crea", "actualiza", "programa", "agenda", "ejecuta", "reserva")):
        return "action"
    return "conversation"


def infer_intent(text: str, capability: str) -> str:
    if capability == "knowledge":
        return "knowledge_lookup"
    if capability == "action":
        return "workflow_progress"
    tokens = [token for token in re.split(r"\W+", text.lower()) if token]
    return "_".join(tokens[:4]) or "general_conversation"


def heuristic_route_decision(payload: RouteDecisionPayload) -> RouteDecision:
    capability = infer_capability(payload.inbound.text)
    intent = infer_intent(payload.inbound.text, capability)
    return RouteDecision(
        capability=capability,  # type: ignore[arg-type]
        intent=intent,
        confidence=0.81 if capability != "conversation" else 0.76,
        needsKnowledge=capability == "knowledge",
        statePatch={"lastCapability": capability, "lastIntent": intent},
        reason="Fallback heuristico del bridge Python."
    )


def format_recent_turns(turns: list[dict], limit: int = 4) -> str:
    rendered: list[str] = []
    for turn in turns[-limit:]:
        role = str(turn.get("role", "unknown")).strip() or "unknown"
        text = str(turn.get("text", "")).strip()
        if text:
            rendered.append(f"{role}: {text}")
    return "\n".join(rendered)


def format_knowledge_snippets(snippets: Iterable[str], limit: int = 3) -> str:
    trimmed = [snippet.strip() for snippet in snippets if snippet.strip()]
    if not trimmed:
        return ""
    return "\n\n".join(f"Fuente {index + 1}: {snippet}" for index, snippet in enumerate(trimmed[:limit]))


def heuristic_conversation_result(context: ExecutionContext) -> CapabilityResult:
    prompt_digest = context.memorySelection.promptDigest.strip()
    summary = context.shortTermState.summary.strip()
    text = context.inbound.text.strip()
    fragments = [
        "Respuesta generica de conversacion desde el servicio Python."
    ]
    if text:
        fragments.append(f"Mensaje: {text}")
    if prompt_digest:
        fragments.append(f"Memoria util: {prompt_digest}")
    elif summary:
        fragments.append(f"Estado previo: {summary}")

    return CapabilityResult(
        responseText=" ".join(fragments),
        statePatch={"stage": "conversation"},
        handoffRequired=False,
        artifacts={"provider": "python-dspy-service", "capability": "conversation", "mode": "heuristic"},
        memoryHints=[text] if text else []
    )


def heuristic_knowledge_result(context: ExecutionContext) -> CapabilityResult:
    snippets = format_knowledge_snippets(document.content for document in context.knowledge)
    text = context.inbound.text.strip()
    response = f"Respuesta de conocimiento generica desde Python. Consulta: {text}."
    if snippets:
        response += f" Contexto: {snippets}"

    return CapabilityResult(
        responseText=response,
        statePatch={"stage": "knowledge"},
        handoffRequired=False,
        artifacts={"provider": "python-dspy-service", "capability": "knowledge", "mode": "heuristic"},
        memoryHints=[text] if text else []
    )


def heuristic_action_result(context: ExecutionContext) -> CapabilityResult:
    text = context.inbound.text.strip()
    return CapabilityResult(
        responseText=f"Respuesta de accion generica desde Python. Solicitud: {text}",
        statePatch={"stage": "action", "pendingAction": "awaiting_follow_up"},
        handoffRequired=False,
        artifacts={"provider": "python-dspy-service", "capability": "action", "mode": "heuristic"},
        memoryHints=[text] if text else []
    )

