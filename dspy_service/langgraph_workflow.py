from __future__ import annotations

from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

RouteName = Literal["conversation", "rag"]


class GraphState(TypedDict, total=False):
    inbound_text: str
    normalized_text: str
    prompt_digest: str
    route: RouteName
    route_reason: str
    knowledge: list[dict[str, Any]]
    response_text: str
    state_patch: dict[str, Any]
    artifacts: dict[str, Any]
    memory_hints: list[str]
    route_confidence: float


def route_classifier(state: GraphState) -> GraphState:
    text = state.get("normalized_text", "")
    if any(token in text for token in ["buscar", "documentacion", "documentación", "informacion", "información", "rag", "fuente"]):
        return {
            "route": "rag",
            "route_reason": "LangGraph clasifico la solicitud como recuperacion de conocimiento.",
            "route_confidence": 0.84,
        }

    return {
        "route": "conversation",
        "route_reason": "LangGraph clasifico la solicitud como continuidad conversacional.",
        "route_confidence": 0.8,
    }


def conversation_node(state: GraphState) -> GraphState:
    inbound_text = state.get("inbound_text", "")
    prompt_digest = state.get("prompt_digest", "")
    continuity = f" Memoria relevante: {prompt_digest}." if prompt_digest else ""
    return {
        "response_text": f"Ruta conversation desde LangGraph. Mensaje recibido: {inbound_text}.{continuity}".strip(),
        "state_patch": {"stage": "conversation"},
        "artifacts": {
            "provider": "python-langgraph-service",
            "capability": "conversation",
            "graphRoute": "conversation",
        },
        "memory_hints": [inbound_text] if inbound_text else [],
    }


def rag_node(state: GraphState) -> GraphState:
    inbound_text = state.get("inbound_text", "")
    knowledge = state.get("knowledge", [])
    snippet = " | ".join(
        str(item.get("content", "")) for item in knowledge[:3] if isinstance(item, dict)
    )
    context = f" Contexto recuperado: {snippet}." if snippet else " No llegaron documentos recuperados."
    return {
        "response_text": f"Ruta rag desde LangGraph. Consulta: {inbound_text}.{context}".strip(),
        "state_patch": {"stage": "knowledge"},
        "artifacts": {
            "provider": "python-langgraph-service",
            "capability": "knowledge",
            "graphRoute": "rag",
            "knowledgeCount": len(knowledge),
        },
        "memory_hints": [inbound_text] if inbound_text else [],
    }


def route_edge(state: GraphState) -> RouteName:
    return state.get("route", "conversation")


_route_graph = StateGraph(GraphState)
_route_graph.add_node("route_classifier", route_classifier)
_route_graph.add_node("conversation", conversation_node)
_route_graph.add_node("rag", rag_node)
_route_graph.add_edge(START, "route_classifier")
_route_graph.add_conditional_edges("route_classifier", route_edge, {"conversation": "conversation", "rag": "rag"})
_route_graph.add_edge("conversation", END)
_route_graph.add_edge("rag", END)
reply_graph = _route_graph.compile()


def run_route_graph(payload: dict[str, Any]) -> GraphState:
    initial_state = build_initial_state(payload)
    result = reply_graph.invoke(initial_state)
    return GraphState(result)


def run_reply_graph(payload: dict[str, Any], forced_route: RouteName) -> GraphState:
    initial_state = build_initial_state(payload)
    if forced_route == "conversation":
        result = conversation_node({**initial_state, "route": "conversation"})
    else:
        result = rag_node({**initial_state, "route": "rag"})
    return GraphState({**initial_state, **result})


def build_route_decision(state: GraphState) -> dict[str, Any]:
    route = state.get("route", "conversation")
    if route == "rag":
        capability = "knowledge"
        intent = "knowledge_lookup"
        needs_knowledge = True
    else:
        capability = "conversation"
        intent = "general_conversation"
        needs_knowledge = False

    return {
        "capability": capability,
        "intent": intent,
        "confidence": state.get("route_confidence", 0.8),
        "needsKnowledge": needs_knowledge,
        "statePatch": {"lastCapability": capability, "lastIntent": intent},
        "reason": state.get("route_reason", "LangGraph route decision."),
    }


def build_capability_result(state: GraphState) -> dict[str, Any]:
    route = state.get("route", "conversation")
    capability = "knowledge" if route == "rag" else "conversation"
    artifacts = dict(state.get("artifacts", {}))
    artifacts.setdefault("capability", capability)

    return {
        "responseText": state.get("response_text", ""),
        "statePatch": state.get("state_patch"),
        "handoffRequired": False,
        "artifacts": artifacts,
        "memoryHints": state.get("memory_hints", []),
    }


def build_initial_state(payload: dict[str, Any]) -> GraphState:
    inbound = payload.get("inbound", {})
    text = str(inbound.get("text", ""))
    knowledge = payload.get("knowledge", [])
    prompt_digest = str(payload.get("memorySelection", {}).get("promptDigest", ""))
    return GraphState(
        inbound_text=text,
        normalized_text=text.lower(),
        prompt_digest=prompt_digest,
        knowledge=knowledge if isinstance(knowledge, list) else [],
    )
