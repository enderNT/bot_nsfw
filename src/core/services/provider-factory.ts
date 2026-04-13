import type { AppSettings } from "../../config";
import type { LlmProvider, MemoryProvider } from "../../domain/ports";
import { GenericLlmProvider } from "./generic-llm-provider";
import { InMemoryMemoryProvider } from "./in-memory-memory-provider";
import { Mem0MemoryProvider } from "./mem0-memory-provider";

export function buildLlmProvider(settings: AppSettings): LlmProvider {
  return new GenericLlmProvider(settings.llm);
}

export function buildMemoryProvider(settings: AppSettings): MemoryProvider {
  switch (settings.memory.provider.toLowerCase()) {
    case "mem0":
      return new Mem0MemoryProvider(settings.memory);
    case "in_memory":
    default:
      return new InMemoryMemoryProvider();
  }
}
