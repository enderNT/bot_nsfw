PYTHON ?= dspy_service/.venv/bin/python
DSPY_HOST ?= 0.0.0.0
DSPY_PORT ?= 8001

.PHONY: dspy
dspy:
	@test -x "$(PYTHON)" || (echo "Python no disponible en $(PYTHON). Crea el entorno con: python3 -m venv dspy_service/.venv && dspy_service/.venv/bin/pip install -r dspy_service/requirements.txt" >&2; exit 1)
	$(PYTHON) -m uvicorn app:app --app-dir dspy_service --host $(DSPY_HOST) --port $(DSPY_PORT) --reload
