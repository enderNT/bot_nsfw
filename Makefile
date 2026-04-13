PYTHON ?= python3
DSPY_HOST ?= 0.0.0.0
DSPY_PORT ?= 8001

.PHONY: dspy
dspy:
	$(PYTHON) -m uvicorn app:app --app-dir dspy_service --host $(DSPY_HOST) --port $(DSPY_PORT) --reload
