from __future__ import annotations

from typing import Literal


def build_route_program(dspy_module):
    class RouteDecisionSignature(dspy_module.Signature):
        """Clasifica el turno entrante en conversation, knowledge o action y decide si hace falta retrieval."""

        inbound_text: str = dspy_module.InputField(desc="Mensaje actual del usuario.")
        channel: str = dspy_module.InputField(desc="Canal de entrada.")
        state_summary: str = dspy_module.InputField(desc="Resumen del estado corto actual.")
        last_capability: str = dspy_module.InputField(desc="Ultima capacidad usada o cadena vacia.")
        last_intent: str = dspy_module.InputField(desc="Ultimo intent usado o cadena vacia.")
        prompt_digest: str = dspy_module.InputField(desc="Resumen compacto de memoria relevante.")

        capability: Literal["conversation", "knowledge", "action"] = dspy_module.OutputField(
            desc="Elige solo uno: conversation, knowledge o action."
        )
        intent: str = dspy_module.OutputField(desc="Intent breve en snake_case.")
        confidence: float = dspy_module.OutputField(desc="Confianza entre 0 y 1.")
        needs_knowledge: bool = dspy_module.OutputField(desc="True solo si se necesita retrieval.")
        reason: str = dspy_module.OutputField(desc="Razon breve y concreta.")

    return dspy_module.ChainOfThought(RouteDecisionSignature)


def build_conversation_program(dspy_module):
    class ConversationReplySignature(dspy_module.Signature):
        """Redacta una respuesta conversacional util y natural en espanol, conservando continuidad."""

        inbound_text: str = dspy_module.InputField(desc="Mensaje actual del usuario.")
        channel: str = dspy_module.InputField(desc="Canal donde llego el mensaje.")
        contact_name: str = dspy_module.InputField(desc="Nombre del contacto o cadena vacia.")
        route_intent: str = dspy_module.InputField(desc="Intent decidido por el router.")
        state_summary: str = dspy_module.InputField(desc="Resumen del estado conversacional.")
        recent_turns: str = dspy_module.InputField(desc="Ultimos turnos relevantes.")
        prompt_digest: str = dspy_module.InputField(desc="Memoria resumida util para contestar.")

        response_text: str = dspy_module.OutputField(desc="Respuesta final lista para enviar al usuario.")
        handoff_required: bool = dspy_module.OutputField(desc="True solo si hace falta derivacion humana.")
        memory_hints: list[str] = dspy_module.OutputField(
            desc="Hechos cortos o pistas que conviene recordar despues del turno."
        )

    return dspy_module.ChainOfThought(ConversationReplySignature)

