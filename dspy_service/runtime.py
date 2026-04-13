from __future__ import annotations

import importlib
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from contracts import (
    CapabilityResult,
    DspyTarget,
    ExecutionContext,
    OptimizeRequest,
    RouteDecision,
    RouteDecisionPayload,
)
from heuristics import (
    format_recent_turns,
    heuristic_action_result,
    heuristic_conversation_result,
    heuristic_knowledge_result,
    heuristic_route_decision,
)
from programs import build_conversation_program, build_route_program


LOGGER = logging.getLogger("dspy_service")
logging.basicConfig(level=os.getenv("DSPY_LOG_LEVEL", "INFO"))

TARGET_TO_FILENAME: dict[DspyTarget, str] = {
    "route_decision": "route-decision.json",
    "conversation": "conversation.json",
}


@dataclass(slots=True)
class DspyServiceSettings:
    model: str = ""
    api_key: str = ""
    api_base: str = ""
    temperature: float = 0.2
    max_tokens: int = 900
    optimized_dir: str = "./dspy_service/optimized"

    @classmethod
    def from_env(cls) -> "DspyServiceSettings":
        return cls(
            model=os.getenv("DSPY_MODEL", "").strip(),
            api_key=os.getenv("DSPY_API_KEY", "").strip(),
            api_base=os.getenv("DSPY_API_BASE", "").strip(),
            temperature=float(os.getenv("DSPY_TEMPERATURE", "0.2")),
            max_tokens=int(os.getenv("DSPY_MAX_TOKENS", "900")),
            optimized_dir=os.getenv("DSPY_OPTIMIZED_DIR", "./dspy_service/optimized").strip() or "./dspy_service/optimized",
        )


class DspyRuntime:
    def __init__(self, settings: DspyServiceSettings | None = None):
        self.settings = settings or DspyServiceSettings.from_env()
        self.base_dir = Path(__file__).resolve().parent
        self.optimized_dir = self._resolve_path(self.settings.optimized_dir)
        self.optimized_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.last_errors: dict[str, str] = {}
        self.last_optimization: dict[str, Any] | None = None
        self.programs: dict[DspyTarget, Any] = {}
        self.optimized_targets: set[DspyTarget] = set()
        self.dspy = self._import_dspy()
        self.lm = self._configure_lm()
        if self.can_use_dspy():
            self.programs = {
                "route_decision": build_route_program(self.dspy),
                "conversation": build_conversation_program(self.dspy),
            }
            self._load_saved_programs()

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "dspyAvailable": self.dspy is not None,
            "lmConfigured": self.lm is not None,
            "model": self.settings.model or None,
            "optimizedTargets": sorted(self.optimized_targets),
            "lastErrors": self.last_errors,
        }

    def predict_route_decision(self, payload: RouteDecisionPayload) -> RouteDecision:
        fallback = heuristic_route_decision(payload)
        if not self.can_use_dspy():
            return fallback

        with self.lock:
            try:
                prediction = self.programs["route_decision"](**self._route_inputs(payload))
            except Exception as exc:  # pragma: no cover - runtime safety
                self.last_errors["route_decision"] = str(exc)
                LOGGER.exception("DSPy route prediction failed, using heuristic fallback.")
                return fallback

        capability = self._clean_capability(getattr(prediction, "capability", None), fallback.capability)
        intent = self._clean_string(getattr(prediction, "intent", None), fallback.intent)
        return RouteDecision(
            capability=capability,
            intent=intent,
            confidence=self._clamp_confidence(getattr(prediction, "confidence", None), fallback.confidence),
            needsKnowledge=self._coerce_bool(getattr(prediction, "needs_knowledge", None), capability == "knowledge"),
            statePatch={"lastCapability": capability, "lastIntent": intent},
            reason=self._clean_string(getattr(prediction, "reason", None), fallback.reason),
        )

    def predict_conversation(self, context: ExecutionContext) -> CapabilityResult:
        fallback = heuristic_conversation_result(context)
        if not self.can_use_dspy():
            return fallback

        with self.lock:
            try:
                prediction = self.programs["conversation"](**self._conversation_inputs(context))
            except Exception as exc:  # pragma: no cover - runtime safety
                self.last_errors["conversation"] = str(exc)
                LOGGER.exception("DSPy conversation prediction failed, using heuristic fallback.")
                return fallback

        response_text = self._clean_string(getattr(prediction, "response_text", None), fallback.responseText)
        memory_hints = self._coerce_string_list(getattr(prediction, "memory_hints", None), fallback.memoryHints)
        return CapabilityResult(
            responseText=response_text,
            statePatch={"stage": "conversation"},
            handoffRequired=self._coerce_bool(getattr(prediction, "handoff_required", None), False),
            artifacts={
                "provider": "python-dspy-service",
                "capability": "conversation",
                "mode": "dspy_optimized" if "conversation" in self.optimized_targets else "dspy",
                "model": self.settings.model or None,
            },
            memoryHints=memory_hints,
        )

    def predict_knowledge(self, context: ExecutionContext) -> CapabilityResult:
        return heuristic_knowledge_result(context)

    def predict_action(self, context: ExecutionContext) -> CapabilityResult:
        return heuristic_action_result(context)

    def optimize(self, request: OptimizeRequest) -> dict[str, Any]:
        if not self.can_use_dspy():
            raise RuntimeError("DSPy no esta disponible o no tiene modelo configurado.")

        start = time.perf_counter()
        trainset = self._build_examples(request.target, request.trainset, request.trainsetPath)
        valset = self._build_examples(request.target, request.valset, request.valsetPath) if (request.valset or request.valsetPath) else None

        if len(trainset) < 2 and valset is None:
            raise ValueError("Se requieren al menos 2 ejemplos de trainset si no se envia valset.")

        optimizer = self.dspy.MIPROv2(
            metric=self._metric_for_target(request.target),
            auto=request.auto,
            max_bootstrapped_demos=request.maxBootstrappedDemos,
            max_labeled_demos=request.maxLabeledDemos,
            num_threads=request.numThreads,
        )

        with self.lock:
            base_program = self._fresh_program(request.target)
            compiled = optimizer.compile(
                base_program,
                trainset=trainset,
                valset=valset,
                seed=request.seed,
            )
            self.programs[request.target] = compiled
            saved_path = None
            if request.save:
                saved_path = self._program_path(request.target)
                compiled.save(str(saved_path), save_program=False)
                self.optimized_targets.add(request.target)

        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        result = {
            "ok": True,
            "target": request.target,
            "trainsetSize": len(trainset),
            "valsetSize": len(valset) if valset is not None else None,
            "savedPath": str(saved_path) if saved_path else None,
            "optimized": True,
            "elapsedMs": elapsed_ms,
            "auto": request.auto,
        }
        self.last_optimization = result
        return result

    def _import_dspy(self):
        try:
            return importlib.import_module("dspy")
        except Exception as exc:  # pragma: no cover - environment dependent
            self.last_errors = {"import": str(exc)}
            LOGGER.warning("DSPy no disponible: %s", exc)
            return None

    def can_use_dspy(self) -> bool:
        return self.dspy is not None and self.lm is not None

    def _configure_lm(self):
        if self.dspy is None or not self.settings.model:
            return None

        kwargs: dict[str, Any] = {
            "temperature": self.settings.temperature,
            "max_tokens": self.settings.max_tokens,
        }
        if self.settings.api_key:
            kwargs["api_key"] = self.settings.api_key
        if self.settings.api_base:
            kwargs["api_base"] = self.settings.api_base

        try:
            lm = self.dspy.LM(self.settings.model, **kwargs)
            self.dspy.configure(lm=lm)
            return lm
        except Exception as exc:  # pragma: no cover - environment dependent
            self.last_errors["lm"] = str(exc)
            LOGGER.warning("No se pudo configurar el LM de DSPy: %s", exc)
            return None

    def _load_saved_programs(self) -> None:
        for target in TARGET_TO_FILENAME:
            path = self._program_path(target)
            if not path.exists():
                continue
            try:
                program = self._fresh_program(target)
                program.load(str(path))
                self.programs[target] = program
                self.optimized_targets.add(target)
            except Exception as exc:  # pragma: no cover - runtime safety
                self.last_errors[f"load:{target}"] = str(exc)
                LOGGER.warning("No se pudo cargar el programa optimizado %s: %s", target, exc)

    def _fresh_program(self, target: DspyTarget):
        if self.dspy is None:
            raise RuntimeError("DSPy no disponible.")
        if target == "route_decision":
            return build_route_program(self.dspy)
        return build_conversation_program(self.dspy)

    def _program_path(self, target: DspyTarget) -> Path:
        return self.optimized_dir / TARGET_TO_FILENAME[target]

    def _route_inputs(self, payload: RouteDecisionPayload) -> dict[str, Any]:
        return {
            "inbound_text": payload.inbound.text,
            "channel": payload.inbound.channel,
            "state_summary": payload.state.summary or "",
            "last_capability": payload.state.lastCapability or "",
            "last_intent": payload.state.lastIntent or "",
            "prompt_digest": payload.promptDigest or "",
        }

    def _conversation_inputs(self, context: ExecutionContext) -> dict[str, Any]:
        return {
            "inbound_text": context.inbound.text,
            "channel": context.inbound.channel,
            "contact_name": context.inbound.contactName or "",
            "route_intent": context.routeDecision.intent,
            "state_summary": context.shortTermState.summary or "",
            "recent_turns": format_recent_turns(context.shortTermState.recentTurns),
            "prompt_digest": context.memorySelection.promptDigest or "",
        }

    def _build_examples(
        self,
        target: DspyTarget,
        inline_records: list[dict[str, Any]] | None,
        records_path: str | None,
    ) -> list[Any]:
        records = inline_records if inline_records is not None else self._load_records(records_path)
        if self.dspy is None:
            raise RuntimeError("DSPy no disponible.")
        if not records:
            raise ValueError("No se encontraron ejemplos para optimizar.")

        examples: list[Any] = []
        for record in records:
            example_record = self._normalize_route_record(record) if target == "route_decision" else self._normalize_conversation_record(record)
            example = self.dspy.Example(**example_record)
            input_keys = (
                "inbound_text",
                "channel",
                "state_summary",
                "last_capability",
                "last_intent",
                "prompt_digest",
            ) if target == "route_decision" else (
                "inbound_text",
                "channel",
                "contact_name",
                "route_intent",
                "state_summary",
                "recent_turns",
                "prompt_digest",
            )
            examples.append(example.with_inputs(*input_keys))
        return examples

    def _load_records(self, path_value: str | None) -> list[dict[str, Any]]:
        if not path_value:
            raise ValueError("Debes enviar `trainsetPath` o `trainset`.")
        path = self._resolve_path(path_value)
        if not path.exists():
            raise FileNotFoundError(f"No existe el dataset: {path}")

        raw = path.read_text(encoding="utf-8").strip()
        if not raw:
            return []
        if path.suffix.lower() == ".jsonl":
            return [json.loads(line) for line in raw.splitlines() if line.strip()]

        data = json.loads(raw)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("examples", "items", "records", "trainset", "valset"):
                value = data.get(key)
                if isinstance(value, list):
                    return value
        raise ValueError(f"Formato de dataset no soportado: {path}")

    def _normalize_route_record(self, record: dict[str, Any]) -> dict[str, Any]:
        inbound = self._as_dict(record.get("inbound"))
        state = self._as_dict(record.get("state"))
        decision = self._as_dict(record.get("decision"))

        capability = self._clean_capability(record.get("capability") or decision.get("capability"), "conversation")
        intent = self._clean_string(record.get("intent") or decision.get("intent"), "general_conversation")
        return {
            "inbound_text": self._clean_string(record.get("inbound_text") or inbound.get("text"), ""),
            "channel": self._clean_string(record.get("channel") or inbound.get("channel"), ""),
            "state_summary": self._clean_string(record.get("state_summary") or state.get("summary"), ""),
            "last_capability": self._clean_string(record.get("last_capability") or state.get("lastCapability"), ""),
            "last_intent": self._clean_string(record.get("last_intent") or state.get("lastIntent"), ""),
            "prompt_digest": self._clean_string(record.get("prompt_digest") or record.get("promptDigest"), ""),
            "capability": capability,
            "intent": intent,
            "confidence": self._clamp_confidence(record.get("confidence") or decision.get("confidence"), 0.8),
            "needs_knowledge": self._coerce_bool(
                record.get("needs_knowledge") if "needs_knowledge" in record else decision.get("needsKnowledge"),
                capability == "knowledge",
            ),
            "reason": self._clean_string(record.get("reason") or decision.get("reason"), "labeled_example"),
        }

    def _normalize_conversation_record(self, record: dict[str, Any]) -> dict[str, Any]:
        context = self._as_dict(record.get("context"))
        inbound = self._as_dict(record.get("inbound")) or self._as_dict(context.get("inbound"))
        state = self._as_dict(record.get("shortTermState")) or self._as_dict(context.get("shortTermState"))
        route = self._as_dict(record.get("routeDecision")) or self._as_dict(context.get("routeDecision"))
        result = self._as_dict(record.get("result"))

        recent_turns = record.get("recent_turns")
        if not isinstance(recent_turns, str):
            recent_turns = format_recent_turns(state.get("recentTurns", [])) if isinstance(state.get("recentTurns"), list) else ""

        return {
            "inbound_text": self._clean_string(record.get("inbound_text") or inbound.get("text"), ""),
            "channel": self._clean_string(record.get("channel") or inbound.get("channel"), ""),
            "contact_name": self._clean_string(record.get("contact_name") or inbound.get("contactName"), ""),
            "route_intent": self._clean_string(record.get("route_intent") or route.get("intent"), "general_conversation"),
            "state_summary": self._clean_string(record.get("state_summary") or state.get("summary"), ""),
            "recent_turns": recent_turns,
            "prompt_digest": self._clean_string(
                record.get("prompt_digest")
                or self._as_dict(record.get("memorySelection")).get("promptDigest")
                or self._as_dict(context.get("memorySelection")).get("promptDigest"),
                "",
            ),
            "response_text": self._clean_string(record.get("response_text") or record.get("responseText") or result.get("responseText"), ""),
            "handoff_required": self._coerce_bool(
                record.get("handoff_required") if "handoff_required" in record else record.get("handoffRequired", result.get("handoffRequired")),
                False,
            ),
            "memory_hints": self._coerce_string_list(record.get("memory_hints") or record.get("memoryHints") or result.get("memoryHints"), []),
        }

    def _metric_for_target(self, target: DspyTarget):
        if target == "route_decision":
            return self._route_metric
        return self._conversation_metric

    def _route_metric(self, example, prediction, trace=None) -> float:  # noqa: ARG002
        score = 0.0
        if self._clean_capability(getattr(prediction, "capability", None), "") == getattr(example, "capability", ""):
            score += 0.55
        if self._clean_string(getattr(prediction, "intent", None), "") == getattr(example, "intent", ""):
            score += 0.20
        expected_needs = self._coerce_bool(getattr(example, "needs_knowledge", None), False)
        predicted_needs = self._coerce_bool(getattr(prediction, "needs_knowledge", None), False)
        if predicted_needs == expected_needs:
            score += 0.15
        confidence_gap = abs(
            self._clamp_confidence(getattr(prediction, "confidence", None), 0.0)
            - self._clamp_confidence(getattr(example, "confidence", None), 0.0)
        )
        score += max(0.0, 0.10 - confidence_gap * 0.10)
        return round(score, 4)

    def _conversation_metric(self, example, prediction, trace=None) -> float:  # noqa: ARG002
        response_score = self._token_f1(
            self._clean_string(getattr(example, "response_text", None), ""),
            self._clean_string(getattr(prediction, "response_text", None), ""),
        )
        handoff_match = 1.0 if self._coerce_bool(getattr(example, "handoff_required", None), False) == self._coerce_bool(getattr(prediction, "handoff_required", None), False) else 0.0
        hints_score = self._jaccard(
            set(self._coerce_string_list(getattr(example, "memory_hints", None), [])),
            set(self._coerce_string_list(getattr(prediction, "memory_hints", None), [])),
        )
        return round(response_score * 0.75 + handoff_match * 0.15 + hints_score * 0.10, 4)

    def _resolve_path(self, raw_path: str) -> Path:
        candidate = Path(raw_path)
        return candidate if candidate.is_absolute() else (self.base_dir.parent / candidate).resolve()

    @staticmethod
    def _as_dict(value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _clean_string(value: Any, fallback: str) -> str:
        if isinstance(value, str):
            cleaned = value.strip()
            return cleaned or fallback
        return fallback

    @staticmethod
    def _clean_capability(value: Any, fallback: str) -> Any:
        if value in {"conversation", "knowledge", "action"}:
            return value
        return fallback

    @staticmethod
    def _coerce_bool(value: Any, fallback: bool) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "1", "yes", "si"}:
                return True
            if lowered in {"false", "0", "no"}:
                return False
        return fallback

    @staticmethod
    def _clamp_confidence(value: Any, fallback: float) -> float:
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return fallback
        return min(1.0, max(0.0, numeric))

    @staticmethod
    def _coerce_string_list(value: Any, fallback: list[str]) -> list[str]:
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str):
            items = [item.strip() for item in value.split(",") if item.strip()]
            return items or fallback
        return fallback

    @staticmethod
    def _token_f1(left: str, right: str) -> float:
        left_tokens = DspyRuntime._tokenize(left)
        right_tokens = DspyRuntime._tokenize(right)
        if not left_tokens or not right_tokens:
            return 0.0
        overlap = len(left_tokens & right_tokens)
        if overlap == 0:
            return 0.0
        precision = overlap / len(right_tokens)
        recall = overlap / len(left_tokens)
        return (2 * precision * recall) / (precision + recall)

    @staticmethod
    def _jaccard(left: set[str], right: set[str]) -> float:
        if not left and not right:
            return 1.0
        if not left or not right:
            return 0.0
        return len(left & right) / len(left | right)

    @staticmethod
    def _tokenize(value: str) -> set[str]:
        return {token for token in re.split(r"\W+", value.lower()) if token}
