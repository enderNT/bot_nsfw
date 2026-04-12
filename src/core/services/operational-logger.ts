import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppSettings } from "../../config";
import type { InboundMessage, RouteDecision } from "../../domain/contracts";

type TerminalPhase = "IN" | "ROUTE" | "FLOW" | "OUT" | "END";

interface LogError {
  owner: string;
  type: string;
  detail: string;
  stage: string;
  impact: string;
}

interface BlockPayload {
  title: string;
  data: Record<string, unknown>;
}

const BRIGHT_SEPARATOR_COLORS = [92, 93, 94, 95, 96] as const;
const RED_COLOR = "\u001b[31m";
const RESET_COLOR = "\u001b[0m";
const NO_VALUE = "n/a";
const MAX_STRING_LENGTH = 600;
const MAX_SERIALIZED_LENGTH = 3_500;

export class OperationalLogger {
  private readonly filePath: string;

  constructor(private readonly settings: AppSettings) {
    this.filePath = resolve(this.settings.logging.directory, this.settings.logging.fileName);
  }

  async logStartup(extra: Record<string, unknown> = {}): Promise<void> {
    const payload = {
      event: "app_started",
      service_name: this.settings.app.name,
      environment: this.settings.app.env,
      host: this.settings.app.host,
      port: this.settings.app.port,
      log_level: this.settings.app.logLevel,
      log_to_console: this.settings.logging.consoleEnabled,
      log_to_file: this.settings.logging.fileEnabled,
      log_file_path: this.settings.logging.fileEnabled ? this.filePath : "disabled",
      ...extra
    };

    if (this.settings.logging.consoleEnabled) {
      console.info(JSON.stringify(payload));
    }

    if (this.settings.logging.fileEnabled) {
      await this.writeFileLines([
        "====> SYSTEM EVENT",
        `timestamp: ${new Date().toISOString()}`,
        formatKeyValueLines(payload),
        "<==== SYSTEM EVENT",
        ""
      ]);
    }
  }

  async logSystemError(stage: string, owner: string, error: unknown, extra: Record<string, unknown> = {}): Promise<void> {
    const capturedError = toLogError(stage, owner, error, "request_failed");
    const sanitizedExtra = sanitizeForLog(extra) as Record<string, unknown>;
    const payload = {
      event: "captured_error",
      ...capturedError,
      ...sanitizedExtra
    };

    if (this.settings.logging.consoleEnabled) {
      console.error(`${RED_COLOR}[ERROR] ${capturedError.stage} ${capturedError.owner} ${capturedError.type}: ${capturedError.detail}${RESET_COLOR}`);
    }

    if (this.settings.logging.fileEnabled) {
      await this.writeFileLines([
        "====> SYSTEM ERROR",
        `timestamp: ${new Date().toISOString()}`,
        formatKeyValueLines(payload),
        "<==== SYSTEM ERROR",
        ""
      ]);
    }
  }

  async startRun(inbound: InboundMessage): Promise<ExecutionLogger> {
    const runId = crypto.randomUUID();
    const colorCode = BRIGHT_SEPARATOR_COLORS[Math.floor(Math.random() * BRIGHT_SEPARATOR_COLORS.length)];
    const startedAt = new Date().toISOString();
    const correlationId = inbound.correlationId ?? inbound.sessionId;

    const execution = new ExecutionLogger({
      parent: this,
      runId,
      correlationId,
      sessionId: inbound.sessionId,
      parentRunId: inbound.parentRunId,
      startedAt,
      inbound,
      colorCode
    });

    await execution.open();
    return execution;
  }

  getOrigin(): Record<string, string> {
    return {
      service_name: this.settings.app.name,
      container_name: this.settings.logging.containerName || NO_VALUE,
      container_id: this.settings.logging.containerId || NO_VALUE,
      instance_id: this.settings.logging.instanceId || NO_VALUE,
      host_name: this.settings.logging.hostName || NO_VALUE,
      environment: this.settings.app.env
    };
  }

  writeConsoleLine(phase: TerminalPhase, message: string, isError = false): void {
    if (!this.settings.logging.consoleEnabled || !message.trim()) {
      return;
    }

    const formatted = `[${phase}]`.padEnd(8);
    if (isError) {
      console.error(`${RED_COLOR}${formatted}${message}${RESET_COLOR}`);
      return;
    }

    console.info(`${formatted}${message}`);
  }

  writeConsoleSeparator(colorCode: number, direction: "start" | "end"): void {
    if (!this.settings.logging.consoleEnabled) {
      return;
    }

    const bar = "═".repeat(60);
    const marker = direction === "start" ? "▼" : "▲";
    const line = direction === "start" ? `${bar}${marker}` : `${marker}${bar}`;
    console.info(`\u001b[${colorCode}m${line}${RESET_COLOR}`);
  }

  async writeExecutionStart(lines: string[]): Promise<void> {
    if (!this.settings.logging.fileEnabled) {
      return;
    }
    await this.writeFileLines(lines);
  }

  async writeExecutionBlock(block: BlockPayload): Promise<void> {
    if (!this.settings.logging.fileEnabled) {
      return;
    }

    await this.writeFileLines([`[${block.title}]`, formatStructuredData(block.data), ""]);
  }

  async writeExecutionEnd(lines: string[]): Promise<void> {
    if (!this.settings.logging.fileEnabled) {
      return;
    }
    await this.writeFileLines(lines);
  }

  private async writeFileLines(lines: string[]): Promise<void> {
    try {
      await mkdir(this.settings.logging.directory, { recursive: true });
      await appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
    } catch (error) {
      if (this.settings.logging.consoleEnabled) {
        console.error(
          `${RED_COLOR}[ERROR] logging file_write ${error instanceof Error ? error.message : "unknown_error"}${RESET_COLOR}`
        );
      }
    }
  }
}

interface ExecutionLoggerOptions {
  parent: OperationalLogger;
  runId: string;
  correlationId: string;
  sessionId: string;
  parentRunId?: string;
  startedAt: string;
  inbound: InboundMessage;
  colorCode: number;
}

export class ExecutionLogger {
  readonly runId: string;

  private readonly parent: OperationalLogger;
  private readonly correlationId: string;
  private readonly sessionId: string;
  private readonly parentRunId?: string;
  private readonly startedAt: string;
  private readonly inbound: InboundMessage;
  private readonly colorCode: number;

  constructor(options: ExecutionLoggerOptions) {
    this.parent = options.parent;
    this.runId = options.runId;
    this.correlationId = options.correlationId;
    this.sessionId = options.sessionId;
    this.parentRunId = options.parentRunId;
    this.startedAt = options.startedAt;
    this.inbound = options.inbound;
    this.colorCode = options.colorCode;
  }

  async open(): Promise<void> {
    this.parent.writeConsoleSeparator(this.colorCode, "start");
    this.parent.writeConsoleLine(
      "IN",
      `run=${shortId(this.runId)} session=${shortId(this.sessionId)} text="${truncate(this.inbound.text, 120)}"`
    );

    await this.parent.writeExecutionStart([
      "====> RUN START",
      `run_id: ${this.runId}`,
      `correlation_id: ${this.correlationId}`,
      `session_id: ${this.sessionId}`,
      `parent_run_id: ${this.parentRunId ?? NO_VALUE}`,
      `started_at: ${this.startedAt}`,
      formatKeyValueLines({ origin: this.parent.getOrigin() }),
      ""
    ]);

    await this.block("01.INPUT", {
      visible_input: this.inbound.text,
      trigger: this.inbound.trigger ?? "http_message",
      channel: this.inbound.channel,
      actor_id: this.inbound.actorId,
      account_id: this.inbound.accountId ?? NO_VALUE,
      contact_name: this.inbound.contactName ?? NO_VALUE,
      identifiers: {
        run_id: this.runId,
        correlation_id: this.correlationId,
        session_id: this.sessionId
      },
      payload_summary: summarizePayload(this.inbound.rawPayload)
    });
  }

  async context(data: {
    shortTermState: unknown;
    memory: {
      provider: string;
      enabled: boolean;
      topK: number;
      scoreThreshold: number;
      rawRecallCount: number;
      promptDigest: string;
    };
  }): Promise<void> {
    await this.block("02.CONTEXT", data);
  }

  async route(data: {
    resolver: string;
    input: Record<string, unknown>;
    decision?: RouteDecision;
    error?: unknown;
    fallback?: string;
  }): Promise<void> {
    const capturedError = data.error ? toLogError("route", data.resolver, data.error, "routing_degraded") : undefined;
    const summary = capturedError
      ? `${capturedError.owner} ${capturedError.type}: ${capturedError.detail}`
      : `${data.resolver} -> ${data.decision?.capability ?? "unknown"} (${truncate(data.decision?.reason ?? "sin razon", 90)})`;

    this.parent.writeConsoleLine("ROUTE", summary, Boolean(capturedError));
    await this.block("03.ROUTE", {
      resolver: data.resolver,
      input: data.input,
      decision: data.decision ?? NO_VALUE,
      fallback: data.fallback ?? NO_VALUE,
      error: capturedError ?? NO_VALUE
    });
  }

  async tool(name: string, data: Record<string, unknown>): Promise<void> {
    await this.block(`04.TOOL.${name}`, data);
  }

  async model(name: string, data: Record<string, unknown>): Promise<void> {
    await this.block(`05.MODEL.${name}`, data);
  }

  async flow(data: {
    selectedFlow: string;
    capability: string;
    result: unknown;
    usedDspy: boolean;
    knowledgeCount: number;
  }): Promise<void> {
    this.parent.writeConsoleLine(
      "FLOW",
      `${data.capability} -> ${truncate(extractConsoleResult(data.result), 110)}`
    );
    await this.block("06.FLOW", data);
  }

  async output(data: {
    destination: string;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
    finalOutput: string;
  }): Promise<void> {
    this.parent.writeConsoleLine("OUT", truncate(data.finalOutput, 110));
    await this.block("07.OUTPUT", data);
  }

  async end(data: { status: string; summary: string; result: string }): Promise<void> {
    const elapsedMs = Date.now() - Date.parse(this.startedAt);
    this.parent.writeConsoleLine("END", `${data.status} elapsed=${elapsedMs}ms`);
    this.parent.writeConsoleSeparator(this.colorCode, "end");

    await this.block("08.END", {
      status: data.status,
      elapsed_ms: elapsedMs,
      summary: data.summary,
      result: data.result
    });

    await this.parent.writeExecutionEnd(["<==== RUN END", ""]);
  }

  async fail(error: unknown): Promise<void> {
    const capturedError = toLogError("execution", "orchestrator", error, "turn_failed");
    this.parent.writeConsoleLine(
      "FLOW",
      `${capturedError.owner} ${capturedError.type}: ${capturedError.detail}`,
      true
    );
    this.parent.writeConsoleLine("END", `error elapsed=${Date.now() - Date.parse(this.startedAt)}ms`, true);
    this.parent.writeConsoleSeparator(this.colorCode, "end");

    await this.block("08.END", {
      status: "error",
      elapsed_ms: Date.now() - Date.parse(this.startedAt),
      summary: "captured_error",
      result: "execution_failed",
      error: capturedError
    });
    await this.parent.writeExecutionEnd(["<==== RUN END", ""]);
  }

  private async block(title: string, data: Record<string, unknown>): Promise<void> {
    await this.parent.writeExecutionBlock({ title, data });
  }
}

function summarizePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      type: Array.isArray(payload) ? "array" : typeof payload,
      preview: sanitizeForLog(payload)
    };
  }

  const record = payload as Record<string, unknown>;
  return {
    type: "object",
    keys: Object.keys(record).slice(0, 20),
    preview: sanitizeForLog(record)
  };
}

function extractConsoleResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }

  const candidate = (result as Record<string, unknown>).responseText;
  return typeof candidate === "string" ? candidate : JSON.stringify(sanitizeForLog(result));
}

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return truncate(value, MAX_STRING_LENGTH);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, MAX_STRING_LENGTH)
    };
  }

  if (depth >= 4) {
    if (Array.isArray(value)) {
      return `[array(${value.length}) truncated]`;
    }
    return "[object truncated]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeForLog(item, depth + 1));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, current] of Object.entries(record)) {
      sanitized[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeForLog(current, depth + 1);
    }
    return sanitized;
  }

  return String(value);
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|key|password|authorization|cookie|credential|api[-_]?key|bearer)/i.test(key);
}

function formatStructuredData(data: Record<string, unknown>): string {
  const serialized = JSON.stringify(sanitizeForLog(data), null, 2) ?? "";
  return truncate(serialized, MAX_SERIALIZED_LENGTH);
}

function formatKeyValueLines(data: Record<string, unknown>): string {
  return Object.entries(sanitizeForLog(data) as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function toLogError(stage: string, owner: string, error: unknown, impact: string): LogError {
  if (error instanceof Error) {
    return {
      owner,
      type: error.name || "Error",
      detail: truncate(error.message, 200),
      stage,
      impact
    };
  }

  return {
    owner,
    type: "UnknownError",
    detail: truncate(String(error), 200),
    stage,
    impact
  };
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 24)}...[truncated ${value.length - maxLength + 24} chars]`;
}
