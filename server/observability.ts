import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startActiveObservation,
  type LangfuseGenerationAttributes,
  type LangfuseObservation,
  type LangfuseObservationAttributes,
  type LangfuseObservationType,
  type LangfuseSpanAttributes
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type {
  ClassroomMetrics,
  ClassroomReport
} from "./classroom/classroomTypes.js";
import type { TrainingEvaluation } from "./storage/chatRepository.js";

type MaybePromise<T> = T | Promise<T>;

export type ObservationHandle = {
  id?: string;
  traceId?: string;
  update(attributes: LangfuseObservationAttributes): void;
  recordScore(name: string, value: number, comment?: string): void;
};

const langfuseEnabled = Boolean(
  process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY
);
const langfuseBaseUrl = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
let langfuseClient: LangfuseClient | undefined;
let otelSdk: NodeSDK | undefined;
let warnedExportError = false;

if (langfuseEnabled) {
  try {
    langfuseClient = new LangfuseClient({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: langfuseBaseUrl,
      timeout: Number(process.env.LANGFUSE_TIMEOUT || 5)
    });
    otelSdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl: langfuseBaseUrl,
          environment: process.env.NODE_ENV || "development",
          mediaUploadEnabled: false,
          timeout: Number(process.env.LANGFUSE_TIMEOUT || 5),
          mask: ({ data }) => sanitizeForLangfuse(data)
        })
      ]
    });
    otelSdk.start();
  } catch (error) {
    warnLangfuse("Langfuse initialization failed", error);
    langfuseClient = undefined;
    otelSdk = undefined;
  }
}

export function isObservabilityEnabled() {
  return langfuseEnabled && Boolean(langfuseClient && otelSdk);
}

export function observeOperation<T>(
  name: string,
  attributes: LangfuseSpanAttributes,
  fn: (observation: ObservationHandle) => MaybePromise<T>,
  options: { asType?: Exclude<LangfuseObservationType, "generation"> } = {}
): MaybePromise<T> {
  if (!isObservabilityEnabled()) {
    return fn(createNoopObservation());
  }

  try {
    return startActiveObservation(
      name,
      async (observation) => fn(createObservationHandle(observation)),
      {
        asType: options.asType || "span"
      } as never
    ) as MaybePromise<T>;
  } catch (error) {
    warnLangfuse(`Langfuse observation failed: ${name}`, error);
    return fn(createNoopObservation());
  }
}

export function observeOperationSync<T>(
  name: string,
  attributes: LangfuseSpanAttributes,
  fn: (observation: ObservationHandle) => T,
  options: { asType?: Exclude<LangfuseObservationType, "generation"> } = {}
): T {
  if (!isObservabilityEnabled()) {
    return fn(createNoopObservation());
  }

  try {
    return startActiveObservation(
      name,
      (observation) => fn(createObservationHandle(observation)),
      {
        asType: options.asType || "span"
      } as never
    ) as T;
  } catch (error) {
    warnLangfuse(`Langfuse sync observation failed: ${name}`, error);
    return fn(createNoopObservation());
  }
}

export function observeGeneration<T>(
  name: string,
  attributes: LangfuseGenerationAttributes,
  fn: (observation: ObservationHandle) => MaybePromise<T>
): MaybePromise<T> {
  if (!isObservabilityEnabled()) {
    return fn(createNoopObservation());
  }

  try {
    return startActiveObservation(
      name,
      async (observation) => fn(createObservationHandle(observation)),
      {
        asType: "generation"
      }
    ) as MaybePromise<T>;
  } catch (error) {
    warnLangfuse(`Langfuse generation failed: ${name}`, error);
    return fn(createNoopObservation());
  }
}

export function summarizeText(value: unknown, maxLength = 1200) {
  if (typeof value !== "string") {
    return value;
  }

  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength)}...`
    : compact;
}

export function summarizeMessages(
  messages: Array<{ role: string; content: unknown }>,
  maxContentLength = 900
) {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? summarizeText(message.content, maxContentLength)
        : "[structured-content]"
  }));
}

export function recordTrainingEvaluationScores(
  observation: ObservationHandle,
  evaluation: TrainingEvaluation
) {
  observation.recordScore(
    "overall_score",
    evaluation.overallScore,
    evaluation.diagnosis.join("；")
  );

  for (const dimension of evaluation.dimensions) {
    observation.recordScore(dimension.name, dimension.score, dimension.comment);
  }
}

export function recordClassroomMetricScores(
  observation: ObservationHandle,
  metrics: ClassroomMetrics
) {
  observation.recordScore("participation", metrics.participation);
  observation.recordScore("understanding", metrics.understanding);
  observation.recordScore("discipline", metrics.discipline);
  observation.recordScore("interaction_quality", metrics.interactionQuality);
}

export function recordClassroomReportScores(
  observation: ObservationHandle,
  report: ClassroomReport,
  metrics?: ClassroomMetrics
) {
  observation.recordScore("overall_score", report.overallScore, report.summary);

  for (const dimension of report.dimensionScores) {
    observation.recordScore(dimension.name, dimension.score, dimension.comment);
  }

  if (metrics) {
    recordClassroomMetricScores(observation, metrics);
  }
}

export async function flushObservability() {
  if (!isObservabilityEnabled()) {
    return;
  }

  try {
    await langfuseClient?.flush();
  } catch (error) {
    warnLangfuse("Langfuse score flush failed", error);
  }
}

function createObservationHandle(observation: LangfuseObservation): ObservationHandle {
  return {
    id: observation.id,
    traceId: observation.traceId,
    update(attributes) {
      try {
        observation.updateOtelSpanAttributes(sanitizeForLangfuse(attributes));
      } catch (error) {
        warnLangfuse("Langfuse observation update failed", error);
      }
    },
    recordScore(name, value, comment) {
      recordTraceScore(observation, name, value, comment);
    }
  };
}

function createNoopObservation(): ObservationHandle {
  return {
    update() {},
    recordScore() {}
  };
}

function recordTraceScore(
  observation: LangfuseObservation,
  name: string,
  value: number,
  comment?: string
) {
  if (!langfuseClient || Number.isNaN(value)) {
    return;
  }

  try {
    langfuseClient.score.trace(
      { otelSpan: observation.otelSpan },
      {
        name,
        value,
        comment: comment ? String(summarizeText(comment, 600)) : undefined
      }
    );
  } catch (error) {
    warnLangfuse(`Langfuse score failed: ${name}`, error);
  }
}

function sanitizeForLangfuse<T>(value: T): T {
  return sanitizeValue(value, 0) as T;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 5) {
    return "[truncated]";
  }

  if (typeof value === "string") {
    if (value.length > 2400) {
      return `${value.slice(0, 2400)}...`;
    }

    if (/^[A-Za-z0-9+/]{2000,}={0,2}$/.test(value)) {
      return "[base64-redacted]";
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 24).map((item) => sanitizeValue(item, depth + 1));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (
      normalizedKey.includes("key") ||
      normalizedKey.includes("secret") ||
      normalizedKey.includes("token") ||
      normalizedKey.includes("password") ||
      normalizedKey === "audio" ||
      normalizedKey === "data"
    ) {
      result[key] = "[redacted]";
      continue;
    }

    result[key] = sanitizeValue(item, depth + 1);
  }

  return result;
}

function warnLangfuse(message: string, error: unknown) {
  if (warnedExportError) {
    return;
  }

  warnedExportError = true;
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[langfuse] ${message}: ${detail}`);
}
