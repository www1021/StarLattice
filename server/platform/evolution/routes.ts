import type { Express, Response } from "express";
import { PlatformError } from "../types.js";
import type { EvolutionService, GateRequest, RolloutRequest } from "./service.js";
import type { GatePolicy } from "./types.js";

function fail(response: Response, error: unknown) {
  if (error instanceof PlatformError) {
    response.status(error.status).json({ message: error.message });
    return;
  }
  console.error("[platform] evolution 请求失败", error);
  response
    .status(500)
    .json({ message: error instanceof Error ? error.message : "演化控制面请求失败。" });
}

function bodyOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function registerEvolutionRoutes(app: Express, service: EvolutionService) {
  app.get("/api/evolution/overview", (_request, response) => {
    try {
      response.json(service.overview());
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/releases", (request, response) => {
    try {
      const workflowId =
        typeof request.query.workflowId === "string" ? request.query.workflowId.trim() : "";
      const limit = Number(request.query.limit);
      response.json({
        releases: service.listReleases(workflowId, Number.isInteger(limit) ? limit : 100)
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/releases", (request, response) => {
    try {
      const body = bodyOf(request.body);
      const workflowId = text(body.workflowId, "workflowId");
      const version = integer(body.version);
      const release = service.createBaselineRelease({
        workflowId,
        version,
        createdBy: optionalText(body.createdBy),
        label: optionalText(body.label)
      });
      response.status(201).json({ release });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/releases/:id", (request, response) => {
    try {
      const release = service.getRelease(request.params.id);
      const resolved = service.resolveRelease(release.id);
      response.json({
        release,
        integrity: {
          hash: release.artifactHash,
          verified: resolved !== undefined
        },
        artifactSummary: {
          workflowId: release.artifact.workflow.id,
          workflowVersion: release.artifact.workflow.version,
          workflowCount: release.artifact.workflows.length,
          agentCount: release.artifact.agents.length
        }
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/releases/:id/rollback", (request, response) => {
    try {
      const body = bodyOf(request.body);
      response.status(202).json(
        service.rollbackRelease(request.params.id, {
          reviewer: optionalText(body.reviewer),
          reason: optionalText(body.reason)
        })
      );
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/candidates", (request, response) => {
    try {
      const workflowId =
        typeof request.query.workflowId === "string" ? request.query.workflowId.trim() : "";
      const limit = Number(request.query.limit);
      response.json({
        candidates: service.listCandidates(workflowId, Number.isInteger(limit) ? limit : 50)
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/candidates", (request, response) => {
    try {
      const body = bodyOf(request.body);
      const candidate = service.createCandidate({
        workflowId: text(body.workflowId, "workflowId"),
        baseReleaseId: optionalText(body.baseReleaseId),
        title: text(body.title, "title"),
        summary: optionalText(body.summary),
        changes: Array.isArray(body.changes) ? (body.changes as never) : [],
        source: normalizeSource(body.source),
        proposedBy: optionalText(body.proposedBy)
      });
      response.status(201).json({ candidate });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/candidates/:id", (request, response) => {
    try {
      const candidate = service.getCandidate(request.params.id);
      response.json({
        candidate,
        evaluations: service.listEvaluationRuns(candidate.id, 20)
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/candidates/:id/gate", async (request, response) => {
    try {
      const body = bodyOf(request.body);
      const gateRequest: GateRequest = {
        mode: body.mode === "live" ? "live" : body.mode === "stub" ? "stub" : undefined,
        datasetId: optionalText(body.datasetId),
        maxCases: integer(body.maxCases),
        policy: parsePolicy(body.policy)
      };
      const result = await service.runGate(request.params.id, gateRequest);
      response.json(result);
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/candidates/:id/approve", (request, response) => {
    try {
      const body = bodyOf(request.body);
      response.json({
        candidate: service.approveCandidate(request.params.id, {
          reviewer: optionalText(body.reviewer),
          comment: optionalText(body.comment)
        })
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/candidates/:id/reject", (request, response) => {
    try {
      const body = bodyOf(request.body);
      response.json({
        candidate: service.rejectCandidate(request.params.id, {
          reviewer: optionalText(body.reviewer),
          comment: optionalText(body.comment)
        })
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/candidates/:id/promote", (request, response) => {
    try {
      const body = bodyOf(request.body);
      const canaryPercent = integer(body.canaryPercent);
      response.status(202).json(
        service.promoteCandidate(request.params.id, {
          reviewer: optionalText(body.reviewer),
          comment: optionalText(body.comment),
          canaryPercent
        })
      );
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/rollouts", (request, response) => {
    try {
      const workflowId =
        typeof request.query.workflowId === "string" ? request.query.workflowId.trim() : "";
      response.json({ rollouts: service.listRollouts(workflowId, 50) });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/rollouts/:id", (request, response) => {
    try {
      const rollouts = service.listRollouts("", 200);
      const rollout = rollouts.find((item) => item.id === request.params.id);
      if (!rollout) {
        throw new PlatformError("金丝雀不存在。", 404);
      }
      response.json({
        rollout,
        observations: service.listObservations(rollout.id),
        guardrail: service.checkGuardrails(rollout.id)
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/rollouts/:id/promote", (request, response) => {
    try {
      const body = bodyOf(request.body);
      response.status(202).json(
        service.promoteRollout(request.params.id, { reviewer: optionalText(body.reviewer) })
      );
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/rollouts/:id/stop", (request, response) => {
    try {
      const body = bodyOf(request.body);
      response.status(202).json(
        service.stopRollout(request.params.id, {
          reviewer: optionalText(body.reviewer),
          reason: optionalText(body.reason)
        })
      );
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/alerts", (request, response) => {
    try {
      const acknowledged =
        request.query.acknowledged === "true"
          ? true
          : request.query.acknowledged === "false"
            ? false
            : undefined;
      const limit = Number(request.query.limit);
      response.json({
        alerts: service.listAlerts({
          acknowledged,
          limit: Number.isInteger(limit) ? limit : 50
        })
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/alerts/:id/ack", (request, response) => {
    try {
      const alert = service.acknowledgeAlert(request.params.id);
      if (!alert) {
        throw new PlatformError("告警不存在。", 404);
      }
      response.json({ alert });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/ledger", (request, response) => {
    try {
      const limit = Number(request.query.limit);
      response.json({
        events: service.listLedger(Number.isInteger(limit) ? limit : 200),
        integrity: service.verifyLedger()
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/ledger/verify", (_request, response) => {
    try {
      response.json(service.verifyLedger());
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/datasets", (request, response) => {
    try {
      const workflowId =
        typeof request.query.workflowId === "string" ? request.query.workflowId.trim() : "";
      response.json({ datasets: service.listDatasets(workflowId) });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/evolution/datasets", (request, response) => {
    try {
      const body = bodyOf(request.body);
      const dataset = service.saveDataset({
        id: optionalText(body.id),
        workflowId: text(body.workflowId, "workflowId"),
        name: text(body.name, "name"),
        description: optionalText(body.description),
        cases: Array.isArray(body.cases) ? (body.cases as never) : []
      });
      response.status(201).json({ dataset });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/evolution/evaluations", (request, response) => {
    try {
      const candidateId =
        typeof request.query.candidateId === "string" ? request.query.candidateId.trim() : "";
      response.json({ evaluations: service.listEvaluationRuns(candidateId, 50) });
    } catch (error) {
      fail(response, error);
    }
  });
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError(`缺少 ${field}。`, 400);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function normalizeSource(value: unknown): "self_loop" | "manual" | "diagnose" | "rollback" {
  return value === "self_loop" || value === "diagnose" || value === "rollback" ? value : "manual";
}

function parsePolicy(value: unknown): Partial<GatePolicy> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const policy: Partial<GatePolicy> = {};
  const numberFields: Array<keyof GatePolicy> = [
    "minTargetDelta",
    "maxCaseDrop",
    "maxMeanDrop",
    "maxCostIncreasePct",
    "confidence"
  ];
  for (const field of numberFields) {
    const raw = record[field];
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new PlatformError(`policy.${field} 必须是数字。`, 400);
      }
      (policy as Record<string, unknown>)[field] = raw;
    }
  }
  const minCases = integer(record.minCases);
  if (minCases !== undefined) {
    policy.minCases = minCases;
  }
  const minCompleted = integer(record.minCompletedPerArm);
  if (minCompleted !== undefined) {
    policy.minCompletedPerArm = minCompleted;
  }
  if (Array.isArray(record.targetCaseIds)) {
    policy.targetCaseIds = record.targetCaseIds.filter(
      (item): item is string => typeof item === "string" && item.trim() !== ""
    );
  }
  return policy;
}
