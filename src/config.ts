export interface AppSettings {
  app: {
    env: string;
    name: string;
    host: string;
    port: number;
    logLevel: string;
    locale: string;
    timezone: string;
  };
  logging: {
    consoleEnabled: boolean;
    fileEnabled: boolean;
    directory: string;
    fileName: string;
    instanceId: string;
    containerName: string;
    containerId: string;
    hostName: string;
  };
  llm: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
    model: string;
    timeoutMs: number;
    temperature?: number;
  };
  router: {
    confidenceThreshold: number;
    knowledgeThreshold: number;
  };
  prompt: {
    memoryMaxItems: number;
    memoryBudgetChars: number;
    recentTurnsLimit: number;
    summarizeOnOverflow: boolean;
  };
  state: {
    refreshTurnThreshold: number;
    refreshCharThreshold: number;
  };
  memory: {
    provider: string;
    enabled: boolean;
    agentId: string;
    topK: number;
    scoreThreshold: number;
  };
  knowledge: {
    provider: string;
    enabled: boolean;
    topK: number;
    timeoutMs: number;
  };
  channel: {
    provider: string;
    replyEnabled: boolean;
  };
  trace: {
    backend: string;
    appKey: string;
    projectorsEnabled: boolean;
    storeRawRecall: boolean;
    storePromptDigest: boolean;
  };
  dspy: {
    enabled: boolean;
    serviceUrl: string;
    timeoutMs: number;
    retryCount: number;
    routeDecisionEnabled: boolean;
    conversationReplyEnabled: boolean;
    knowledgeReplyEnabled: boolean;
    actionReplyEnabled: boolean;
  };
}

function readString(name: string, fallback: string): string {
  return globalThis.Bun?.env[name] ?? process.env[name] ?? fallback;
}

function readNumber(name: string, fallback: number): number {
  const value = globalThis.Bun?.env[name] ?? process.env[name];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = (globalThis.Bun?.env[name] ?? process.env[name])?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function loadSettings(): AppSettings {
  return {
    app: {
      env: readString("APP_ENV", "development"),
      name: readString("APP_NAME", "stateful-assistant"),
      host: readString("APP_HOST", "0.0.0.0"),
      port: readNumber("APP_PORT", 3000),
      logLevel: readString("APP_LOG_LEVEL", "INFO"),
      locale: readString("APP_DEFAULT_LOCALE", "es-MX"),
      timezone: readString("APP_DEFAULT_TIMEZONE", "America/Mexico_City")
    },
    logging: {
      consoleEnabled: readBoolean("APP_LOG_TO_CONSOLE", true),
      fileEnabled: readBoolean("APP_LOG_TO_FILE", true),
      directory: readString("APP_LOG_DIR", "./var/log/stateful-assistant"),
      fileName: readString("APP_LOG_FILE", "app.log"),
      instanceId: readString("APP_INSTANCE_ID", ""),
      containerName: readString("APP_CONTAINER_NAME", ""),
      containerId: readString("APP_CONTAINER_ID", ""),
      hostName: readString("APP_HOST_NAME", readString("HOSTNAME", ""))
    },
    llm: {
      provider: readString("LLM_PROVIDER", "openai_compatible"),
      apiKey: readString("LLM_API_KEY", ""),
      baseUrl: readString("LLM_BASE_URL", ""),
      model: readString("LLM_MODEL", "gpt-5-mini"),
      timeoutMs: readNumber("LLM_TIMEOUT_MS", 30000),
      temperature: (() => {
        const raw = globalThis.Bun?.env.LLM_TEMPERATURE ?? process.env.LLM_TEMPERATURE;
        return raw ? Number(raw) : undefined;
      })()
    },
    router: {
      confidenceThreshold: readNumber("ROUTER_CONFIDENCE_THRESHOLD", 0.62),
      knowledgeThreshold: readNumber("ROUTER_KNOWLEDGE_THRESHOLD", 0.58)
    },
    prompt: {
      memoryMaxItems: readNumber("PROMPT_MEMORY_MAX_ITEMS", 3),
      memoryBudgetChars: readNumber("PROMPT_MEMORY_BUDGET_CHARS", 1200),
      recentTurnsLimit: readNumber("PROMPT_RECENT_TURNS_LIMIT", 3),
      summarizeOnOverflow: readBoolean("PROMPT_SUMMARIZE_ON_OVERFLOW", true)
    },
    state: {
      refreshTurnThreshold: readNumber("STATE_SUMMARY_REFRESH_TURN_THRESHOLD", 4),
      refreshCharThreshold: readNumber("STATE_SUMMARY_REFRESH_CHAR_THRESHOLD", 900)
    },
    memory: {
      provider: readString("MEMORY_PROVIDER", "in_memory"),
      enabled: readBoolean("MEMORY_ENABLED", true),
      agentId: readString("MEMORY_AGENT_ID", "default-assistant"),
      topK: readNumber("MEMORY_TOP_K", 5),
      scoreThreshold: readNumber("MEMORY_SCORE_THRESHOLD", 0)
    },
    knowledge: {
      provider: readString("KNOWLEDGE_PROVIDER", "none"),
      enabled: readBoolean("KNOWLEDGE_ENABLED", false),
      topK: readNumber("KNOWLEDGE_TOP_K", 5),
      timeoutMs: readNumber("KNOWLEDGE_TIMEOUT_MS", 10000)
    },
    channel: {
      provider: readString("CHANNEL_PROVIDER", "none"),
      replyEnabled: readBoolean("CHANNEL_REPLY_ENABLED", false)
    },
    trace: {
      backend: readString("TRACE_BACKEND", "in_memory"),
      appKey: readString("TRACE_APP_KEY", "stateful-assistant"),
      projectorsEnabled: readBoolean("TRACE_PROJECTORS_ENABLED", true),
      storeRawRecall: readBoolean("TRACE_STORE_RAW_RECALL", true),
      storePromptDigest: readBoolean("TRACE_STORE_PROMPT_DIGEST", true)
    },
    dspy: {
      enabled: readBoolean("DSPY_ENABLED", false),
      serviceUrl: readString("DSPY_SERVICE_URL", "http://dspy-service:8001"),
      timeoutMs: readNumber("DSPY_TIMEOUT_MS", 4000),
      retryCount: readNumber("DSPY_RETRY_COUNT", 1),
      routeDecisionEnabled: readBoolean("DSPY_ROUTE_DECISION_ENABLED", false),
      conversationReplyEnabled: readBoolean("DSPY_CONVERSATION_REPLY_ENABLED", false),
      knowledgeReplyEnabled: readBoolean("DSPY_KNOWLEDGE_REPLY_ENABLED", false),
      actionReplyEnabled: readBoolean("DSPY_ACTION_REPLY_ENABLED", false)
    }
  };
}
