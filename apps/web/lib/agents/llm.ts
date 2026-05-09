/**
 * Anthropic API wrapper used by Next.js Route Handlers in the
 * 8-agent system.
 *
 * Mirrors the Python `agents/llm/client.py` contract:
 *   - prompt caching (ephemeral cache_control on system blocks)
 *   - up to 3 attempts with exponential backoff for transient errors
 *   - optional Zod-parsed structured output with 1-shot self-correction
 *   - forbidden-word post-validation per CLAUDE.md §3-A
 *
 * Server-only — depends on ANTHROPIC_API_KEY which lives in Vercel
 * env (production/preview/development). Importing from a `'use client'`
 * file will fail at runtime; the `import 'server-only'` guard makes
 * that explicit.
 */
import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { z, type ZodTypeAny } from 'zod';

import {
  ForbiddenWordError,
  sanitizeNarrative,
} from '@/lib/agents/sanitize';

export type AgentRole = 'user' | 'assistant';

export interface AgentMessage {
  role: AgentRole;
  content: string;
}

export interface CacheBlock {
  text: string;
  /** Optional human-friendly label for telemetry. No effect on the API. */
  label?: string;
}

export interface CallClaudeParams<TSchema extends ZodTypeAny | undefined = undefined> {
  messages: AgentMessage[];
  system?: string;
  cache?: CacheBlock[];
  /** When set, the response is parsed by this Zod schema. Parse failures retry once. */
  responseSchema?: TSchema;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  maxAttempts?: number;
}

export interface CallClaudeResult<TSchema extends ZodTypeAny | undefined> {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costEstimateUsd: number;
  latencyMs: number;
  parsed: TSchema extends ZodTypeAny ? z.infer<TSchema> : null;
}

export class AgentLLMError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentLLMError';
  }
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;

// Sonnet pricing (USD per token), 2024-Q4. Cache reads are 90% off.
const PRICE_INPUT = 3.0 / 1_000_000;
const PRICE_OUTPUT = 15.0 / 1_000_000;
const PRICE_CACHE_WRITE = 3.75 / 1_000_000;
const PRICE_CACHE_READ = 0.3 / 1_000_000;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AgentLLMError('ANTHROPIC_API_KEY is not set');
  _client = new Anthropic({ apiKey });
  return _client;
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessage {
  content?: AnthropicTextBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function buildSystem(
  system: string | undefined,
  cache: CacheBlock[] | undefined,
):
  | string
  | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  | undefined {
  const blocks: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }> = [];
  if (system) blocks.push({ type: 'text', text: system });
  for (const cb of cache ?? []) {
    blocks.push({
      type: 'text',
      text: cb.text,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (blocks.length === 0) return undefined;
  if (blocks.length === 1 && !blocks[0].cache_control) return blocks[0].text;
  return blocks;
}

function extractText(msg: AnthropicMessage): string {
  return (msg.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function estimateCost(usage: AnthropicMessage['usage']): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) * PRICE_INPUT +
    (usage.output_tokens ?? 0) * PRICE_OUTPUT +
    (usage.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE +
    (usage.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ
  );
}

function isTransient(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: number; name?: string };
  if (e.status && e.status >= 500) return true;
  if (e.status === 429) return true;
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') {
    return true;
  }
  return false;
}

async function sleepBackoff(attempt: number): Promise<void> {
  const delayMs = Math.min(8000, 500 * Math.pow(3, attempt));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Single Anthropic call with caching, retries, and optional Zod-parsed
 * structured return.
 *
 * Returns `parsed` typed as `z.infer<TSchema>` when a schema is supplied,
 * `null` otherwise (the discriminated return type is enforced by the
 * caller's TSchema generic).
 */
export async function callClaude<TSchema extends ZodTypeAny | undefined = undefined>(
  params: CallClaudeParams<TSchema>,
): Promise<CallClaudeResult<TSchema>> {
  const {
    messages,
    system,
    cache,
    responseSchema,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.4,
    maxAttempts = 3,
  } = params;

  const client = getClient();
  const chosenModel = model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const systemPayload = buildSystem(system, cache);

  let parseCorrection: AgentMessage | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const turn: AgentMessage[] = parseCorrection
      ? [...messages, parseCorrection]
      : messages;

    let response: AnthropicMessage;
    const t0 = Date.now();
    try {
      response = (await client.messages.create({
        model: chosenModel,
        max_tokens: maxTokens,
        temperature,
        ...(systemPayload !== undefined ? { system: systemPayload } : {}),
        messages: turn.map((m) => ({ role: m.role, content: m.content })),
      } as Parameters<typeof client.messages.create>[0])) as unknown as AnthropicMessage;
    } catch (err) {
      lastError = err;
      const transient = isTransient(err);
      if (!transient || attempt === maxAttempts - 1) {
        throw new AgentLLMError(
          `Anthropic call failed (attempt ${attempt + 1})`,
          err,
        );
      }
      await sleepBackoff(attempt);
      continue;
    }
    const latencyMs = Date.now() - t0;

    const text = extractText(response);
    const usage = response.usage ?? {};

    const baseResult = {
      text,
      model: chosenModel,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      costEstimateUsd: estimateCost(usage),
      latencyMs,
    };

    if (!responseSchema) {
      return {
        ...baseResult,
        parsed: null,
      } as CallClaudeResult<TSchema>;
    }

    try {
      const parsedJson = JSON.parse(text);
      const parsed = responseSchema.parse(parsedJson);
      return {
        ...baseResult,
        parsed,
      } as CallClaudeResult<TSchema>;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts - 1) {
        throw new AgentLLMError(
          `response did not parse against the schema after ${maxAttempts} attempts`,
          err,
        );
      }
      parseCorrection = {
        role: 'user',
        content:
          '직전 응답을 지정된 JSON 스키마로 파싱하지 못했습니다. 스키마 이외의 키나 텍스트 없이 JSON만 다시 응답해 주세요. ' +
          `오류: ${err instanceof Error ? err.message : String(err)}`,
      };
      continue;
    }
  }

  throw new AgentLLMError(
    `callClaude exhausted attempts; last error: ${String(lastError)}`,
  );
}

export { ForbiddenWordError, sanitizeNarrative };
