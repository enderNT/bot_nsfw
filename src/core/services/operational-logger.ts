import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { AppSettings } from "../../config";
import type { InboundMessage, RouteDecision } from "../../domain/contracts";

type TerminalPhase = "IN" | "MEM" | "ROUTE" | "FLOW" | "OUT" | "END";

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
  private readonly fileDirectory: string;
  private readonly fileBaseName: string;
  private readonly fileExtension: string;
  private readonly maxFiles: number;
  private readonly maxLinesPerFile: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly settings: AppSettings) {
    this.filePath = resolve(this.settings.logging.directory, this.settings.logging.fileName);
    this.fileDirectory = dirname(this.filePath);
    this.fileExtension = extname(this.filePath);
    this.fileBaseName = basename(this.filePath, this.fileExtension);
    this.maxFiles = Math.max(1, Math.floor(this.settings.logging.maxFiles));
    this.maxLinesPerFile = Math.max(1, Math.floor(this.settings.logging.maxLinesPerFile));
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
    const task = this.writeQueue.then(() => this.writeFileLinesInternal(lines));
    this.writeQueue = task.catch(() => undefined);
    await task;
  }

  private async writeFileLinesInternal(lines: string[]): Promise<void> {
    try {
      await mkdir(this.fileDirectory, { recursive: true });
      await this.cleanupExtraLogFiles();

      const normalizedLines = `${lines.join("\n")}\n`
        .split("\n")
        .slice(0, -1);

      let remaining = normalizedLines;
      while (remaining.length > 0) {
        const activeFile = await this.resolveActiveLogFile();
        const availableLines = this.maxLinesPerFile - activeFile.lineCount;

        if (availableLines <= 0) {
          const rotatedFile = this.buildLogFilePath((activeFile.index + 1) % this.maxFiles);
          const nextChunk = remaining.slice(0, this.maxLinesPerFile);
          await writeFile(rotatedFile, `${nextChunk.join("\n")}\n`, "utf8");
          remaining = remaining.slice(nextChunk.length);
          continue;
        }

        const nextChunk = remaining.slice(0, availableLines);
        await appendFile(activeFile.path, `${nextChunk.join("\n")}\n`, "utf8");
        remaining = remaining.slice(nextChunk.length);
      }
    } catch (error) {
      if (this.settings.logging.consoleEnabled) {
        console.error(
          `${RED_COLOR}[ERROR] logging file_write ${error instanceof Error ? error.message : "unknown_error"}${RESET_COLOR}`
        );
      }
    }
  }

  private async resolveActiveLogFile(): Promise<{ index: number; path: string; lineCount: number; mtimeMs: number }> {
    const files = await this.listManagedLogFiles();
    if (files.length === 0) {
      const path = this.buildLogFilePath(0);
      await writeFile(path, "", "utf8");
      return {
        index: 0,
        path,
        lineCount: 0,
        mtimeMs: Date.now()
      };
    }

    return files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.index - left.index)[0]!;
  }

  private async listManagedLogFiles(): Promise<Array<{ index: number; path: string; lineCount: number; mtimeMs: number }>> {
    const entries = await readdir(this.fileDirectory, { withFileTypes: true }).catch(() => []);
    const managedFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        index: this.parseManagedFileIndex(entry.name)
      }))
      .filter((entry): entry is { name: string; index: number } => entry.index !== null)
      .filter((entry) => entry.index < this.maxFiles);

    const result: Array<{ index: number; path: string; lineCount: number; mtimeMs: number }> = [];
    for (const entry of managedFiles) {
      const path = join(this.fileDirectory, entry.name);
      const [content, metadata] = await Promise.all([
        readFile(path, "utf8").catch(() => ""),
        stat(path).catch(() => ({ mtimeMs: 0 }))
      ]);

      result.push({
        index: entry.index,
        path,
        lineCount: countFileLines(content),
        mtimeMs: metadata.mtimeMs
      });
    }

    return result;
  }

  private async cleanupExtraLogFiles(): Promise<void> {
    const entries = await readdir(this.fileDirectory, { withFileTypes: true }).catch(() => []);
    const extraFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        index: this.parseManagedFileIndex(entry.name)
      }))
      .filter((entry): entry is { name: string; index: number } => entry.index !== null)
      .filter((entry) => entry.index >= this.maxFiles);

    await Promise.all(extraFiles.map((entry) => rm(join(this.fileDirectory, entry.name), { force: true })));
  }

  private parseManagedFileIndex(fileName: string): number | null {
    if (fileName === `${this.fileBaseName}${this.fileExtension}`) {
      return 0;
    }

    const match = fileName.match(new RegExp(`^${escapeRegExp(this.fileBaseName)}\\.(\\d+)${escapeRegExp(this.fileExtension)}$`));
    if (!match) {
      return null;
    }

    return Number(match[1]);
  }

  private buildLogFilePath(index: number): string {
    if (index === 0) {
      return this.filePath;
    }

    return join(this.fileDirectory, `${this.fileBaseName}.${index}${this.fileExtension}`);
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

  async memoryRead(name: string, data: {
    scope: "short_term" | "long_term";
    component: string;
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    status: string;
    error?: unknown;
  }): Promise<void> {
    const capturedError = data.error ? toLogError("memory_read", data.component, data.error, "memory_read_failed") : undefined;
    this.parent.writeConsoleLine(
      "MEM",
      capturedError ? formatMemoryErrorSummary(data.scope, "read", capturedError) : formatMemoryReadSummary(data.scope, data.component, data.response),
      Boolean(capturedError)
    );

    await this.block(`02.MEMORY.READ.${name}`, {
      scope: data.scope,
      component: data.component,
      request: data.request ?? NO_VALUE,
      response: data.response ?? NO_VALUE,
      status: data.status,
      error: capturedError ?? NO_VALUE
    });
  }

  async memoryWrite(name: string, data: {
    scope: "short_term" | "long_term";
    component: string;
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    status: string;
    error?: unknown;
  }): Promise<void> {
    const capturedError = data.error ? toLogError("memory_write", data.component, data.error, "memory_write_failed") : undefined;
    this.parent.writeConsoleLine(
      "MEM",
      capturedError ? formatMemoryErrorSummary(data.scope, "write", capturedError) : formatMemoryWriteSummary(data.scope, data.component, data.response),
      Boolean(capturedError)
    );

    await this.block(`07.MEMORY.WRITE.${name}`, {
      scope: data.scope,
      component: data.component,
      request: data.request ?? NO_VALUE,
      response: data.response ?? NO_VALUE,
      status: data.status,
      error: capturedError ?? NO_VALUE
    });
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

function formatMemoryReadSummary(
  scope: "short_term" | "long_term",
  component: string,
  response?: Record<string, unknown>
): string {
  if (scope === "short_term") {
    const turnCount = formatConsoleScalar(response?.turnCount);
    const summary = truncate(String(response?.summaryPreview ?? ""), 60);
    return `${scope} read ${component} turns=${turnCount} summary="${summary || NO_VALUE}"`;
  }

  const count = formatConsoleScalar(response?.count);
  const promptDigest = truncate(String(response?.promptDigest ?? ""), 60);
  return `${scope} read ${component} count=${count} digest="${promptDigest || NO_VALUE}"`;
}

function formatMemoryWriteSummary(
  scope: "short_term" | "long_term",
  component: string,
  response?: Record<string, unknown>
): string {
  if (scope === "short_term") {
    const turnCount = formatConsoleScalar(response?.turnCount);
    const stage = formatConsoleScalar(response?.stage);
    return `${scope} write ${component} turns=${turnCount} stage=${stage}`;
  }

  const stored = formatConsoleScalar(response?.stored);
  const count = formatConsoleScalar(response?.count);
  return `${scope} write ${component} stored=${stored} count=${count}`;
}

function formatMemoryErrorSummary(
  scope: "short_term" | "long_term",
  operation: "read" | "write",
  error: LogError
): string {
  return `${scope} ${operation} ${error.owner} ${error.type}: ${error.detail}`;
}

function formatConsoleScalar(value: unknown): string {
  if (value == null || value === "") {
    return NO_VALUE;
  }

  return truncate(String(value), 60);
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

function countFileLines(content: string): number {
  if (!content) {
    return 0;
  }

  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
