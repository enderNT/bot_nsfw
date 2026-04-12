# LangGraph en el Boilerplate

## Alcance actual

La integración actual de `LangGraph` vive en `dspy_service/` y está pensada como una primera capa de orquestación Python conectada al core Bun por HTTP.

Por ahora el grafo solo cubre dos rutas:

- `conversation`
- `rag`

## Mapeo con el core

El core del boilerplate sigue manejando estos capabilities:

- `conversation`
- `knowledge`
- `action`

Para no romper contratos existentes:

- la ruta `conversation` de LangGraph se devuelve como capability `conversation`
- la ruta `rag` de LangGraph se devuelve como capability `knowledge`

## Flujo

1. Bun normaliza el inbound.
2. El `HttpDspyBridge` envía payload al servicio Python si está habilitado.
3. `LangGraph` clasifica la ruta principal.
4. El nodo correspondiente produce la respuesta.
5. Bun conserva la responsabilidad de persistencia, memoria, logging y emisión.

## Rutas implementadas

### conversation

Se usa para continuidad conversacional y puede aprovechar `promptDigest` como memoria resumida.

### rag

Se usa para consultas que requieren contexto recuperado. Consume la lista `knowledge` que ya arma el core del boilerplate.

## Lo que todavía no cubre

Esta primera iteración no mueve todo el sistema a LangGraph. Aún quedan fuera:

- `action`
- tools reales dentro del grafo
- persistencia de estado del grafo
- nodos de recuperación reales
- uso de LLM real dentro del servicio Python

## Archivos clave

- `dspy_service/app.py`
- `dspy_service/langgraph_workflow.py`
- `src/core/services/http-dspy-bridge.ts`
