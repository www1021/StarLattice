import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type TrainingType = "教案诊断" | "说课陪练" | "模拟课堂" | "实习反思";

export type StoredChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type StoredArtifact = {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
};

export type StoredCitation = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentName: string;
  snippet: string;
  source: "local" | "ima" | "external";
  score: number;
};

export type EvaluationDimension = {
  name: string;
  score: number;
  comment: string;
};

export type TrainingEvaluation = {
  id: string;
  conversationId: string;
  trainingType: TrainingType;
  overallScore: number;
  dimensions: EvaluationDimension[];
  diagnosis: string[];
  suggestions: string[];
  nextTask: string;
  citations: StoredCitation[];
  createdAt: string;
};

export type ConversationSaveInput = {
  conversationId: string;
  title: string;
  trainingType: TrainingType;
  messages: StoredChatMessage[];
  knowledgeBaseIds: string[];
  attachmentNames: string[];
  artifacts: StoredArtifact[];
  citations: StoredCitation[];
};

export type ConversationSummary = {
  id: string;
  title: string;
  trainingType: TrainingType;
  messageCount: number;
  artifactCount: number;
  citationCount: number;
  attachmentNames: string[];
  knowledgeBaseIds: string[];
  latestEvaluation?: TrainingEvaluation;
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationDetail = ConversationSummary & {
  messages: StoredChatMessage[];
  artifacts: StoredArtifact[];
  citations: StoredCitation[];
};

export type GrowthSummary = {
  totalTrainings: number;
  averageScore: number;
  growthStage: GrowthStage;
  recommendedAction: RecommendedAction;
  dimensionAverages: EvaluationDimension[];
  trainingTypeCounts: Record<TrainingType, number>;
  trainingTypeSummaries: TrainingTypeGrowthSummary[];
  growthTimeline: GrowthTimelineItem[];
  evidenceRecords: GrowthEvidenceRecord[];
  representativeArtifacts: RepresentativeArtifact[];
  capabilityMatrix: CapabilityMatrixItem[];
  reflectionSummary: ReflectionGrowthSummary;
  recentConversations: ConversationSummary[];
  recentEvaluations: TrainingEvaluation[];
  weakDimensions: EvaluationDimension[];
  recommendedNextTask: string;
};

type AgentOperationStats = {
  studentAgentActivations: number;
  observerTips: number;
  eventAgentTriggers: number;
  evidenceChains: number;
  classroomEventHandlingRate: number;
};

export type GrowthStage = "建立基线" | "补齐训练" | "专项提升";

export type RecommendedAction = {
  trainingType: TrainingType;
  reason: string;
  objective: string;
  completionCriteria: string;
  prompt: string;
};

export type GrowthTimelineItem = {
  id: string;
  title: string;
  trainingType: TrainingType;
  score: number;
  dimensions: EvaluationDimension[];
  weakDimensions: string[];
  artifactCount: number;
  nextTask: string;
  createdAt: string;
};

export type GrowthEvidenceRecord = GrowthTimelineItem & {
  citationCount: number;
};

export type RepresentativeArtifact = {
  id: string;
  title: string;
  trainingType: TrainingType;
  score: number;
  artifactCount: number;
  citationCount: number;
  reason: string;
  createdAt: string;
};

export type CapabilityMatrixItem = {
  name: string;
  score: number;
  evidence: string;
  nextAction: string;
};

export type ReflectionGrowthSummary = {
  totalReflections: number;
  latestTitle?: string;
  latestScore?: number;
  evidenceCount: number;
  nextAction: string;
};

export type TrainingTypeGrowthSummary = {
  trainingType: TrainingType;
  count: number;
  averageScore: number;
  latestTitle?: string;
  latestScore?: number;
  evidenceCount: number;
  artifactCount: number;
  citationCount: number;
  status: "已覆盖" | "待训练";
  nextAction: string;
};

type ConversationRow = {
  id: string;
  title: string;
  training_type: TrainingType;
  knowledge_base_ids: string;
  attachment_names: string;
  artifact_count: number;
  citation_count: number;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message?: string;
};

type MessageRow = {
  role: "user" | "assistant";
  content: string;
};

type ArtifactRow = StoredArtifact;
type CitationRow = {
  id: string;
  knowledge_base_id: string;
  knowledge_base_name: string;
  document_id: string;
  document_name: string;
  snippet: string;
  source: "local";
  score: number;
};

type EvaluationRow = {
  id: string;
  conversation_id: string;
  training_type: TrainingType;
  overall_score: number;
  dimensions_json: string;
  diagnosis_json: string;
  suggestions_json: string;
  next_task: string;
  citations_json: string;
  created_at: string;
};

export type ChatRepository = {
  saveConversation(input: ConversationSaveInput): Promise<void>;
  listConversations(): ConversationSummary[];
  getConversation(conversationId: string): ConversationDetail | undefined;
  saveEvaluation(evaluation: TrainingEvaluation): Promise<void>;
  saveSpeakTrainingSession(conversationId: string, snapshotJson: string): Promise<void>;
  getSpeakTrainingSession(conversationId: string): string | undefined;
  getEvaluation(conversationId: string): TrainingEvaluation | undefined;
  listEvaluations(limit?: number): TrainingEvaluation[];
  getGrowthSummary(): GrowthSummary;
  saveGrowthSnapshot(summary: GrowthSummary): void;
};

const trainingTypes: TrainingType[] = [
  "教案诊断",
  "说课陪练",
  "模拟课堂",
  "实习反思"
];

export class SQLiteChatRepository implements ChatRepository {
  private readonly db: Database.Database;

  constructor(dbPath = path.resolve("data", "training.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  async saveConversation(input: ConversationSaveInput) {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT created_at FROM conversations WHERE id = ?")
      .get(input.conversationId) as { created_at: string } | undefined;

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO conversations
            (id, title, training_type, knowledge_base_ids, attachment_names,
             artifact_count, citation_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            training_type = excluded.training_type,
            knowledge_base_ids = excluded.knowledge_base_ids,
            attachment_names = excluded.attachment_names,
            artifact_count = excluded.artifact_count,
            citation_count = excluded.citation_count,
            updated_at = excluded.updated_at
          `
        )
        .run(
          input.conversationId,
          input.title,
          input.trainingType,
          JSON.stringify(input.knowledgeBaseIds),
          JSON.stringify(input.attachmentNames),
          input.artifacts.length,
          input.citations.length,
          existing?.created_at || now,
          now
        );

      this.db
        .prepare("DELETE FROM conversation_messages WHERE conversation_id = ?")
        .run(input.conversationId);
      this.db
        .prepare("DELETE FROM conversation_artifacts WHERE conversation_id = ?")
        .run(input.conversationId);
      this.db
        .prepare("DELETE FROM conversation_citations WHERE conversation_id = ?")
        .run(input.conversationId);

      const insertMessage = this.db.prepare(
        `
        INSERT INTO conversation_messages
          (id, conversation_id, role, content, message_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `
      );
      input.messages.forEach((message, index) => {
        insertMessage.run(
          `msg_${randomUUID()}`,
          input.conversationId,
          message.role,
          message.content,
          index,
          now
        );
      });

      const insertArtifact = this.db.prepare(
        `
        INSERT INTO conversation_artifacts
          (id, conversation_id, name, type, url, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      );
      for (const artifact of input.artifacts) {
        insertArtifact.run(
          artifact.id,
          input.conversationId,
          artifact.name,
          artifact.type,
          artifact.url,
          artifact.size,
          now
        );
      }

      const insertCitation = this.db.prepare(
        `
        INSERT INTO conversation_citations
          (id, conversation_id, knowledge_base_id, knowledge_base_name,
           document_id, document_name, snippet, source, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      );
      input.citations.forEach((citation, index) => {
        insertCitation.run(
          buildConversationCitationId(input.conversationId, citation.id, index),
          input.conversationId,
          citation.knowledgeBaseId,
          citation.knowledgeBaseName,
          citation.documentId,
          citation.documentName,
          citation.snippet,
          citation.source,
          citation.score,
          now
        );
      });
    });

    transaction();
  }

  listConversations() {
    const rows = this.db
      .prepare(
        `
        SELECT
          conversations.*,
          COUNT(conversation_messages.id) AS message_count,
          (
            SELECT content
            FROM conversation_messages
            WHERE conversation_id = conversations.id
            ORDER BY message_index DESC
            LIMIT 1
          ) AS last_message
        FROM conversations
        LEFT JOIN conversation_messages
          ON conversation_messages.conversation_id = conversations.id
        GROUP BY conversations.id
        ORDER BY conversations.updated_at DESC
        `
      )
      .all() as ConversationRow[];

    return rows.map((row) => this.rowToSummary(row));
  }

  getConversation(conversationId: string) {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(conversationId) as ConversationRow | undefined;

    if (!row) {
      return undefined;
    }

    const messages = this.db
      .prepare(
        `
        SELECT role, content
        FROM conversation_messages
        WHERE conversation_id = ?
        ORDER BY message_index ASC
        `
      )
      .all(conversationId) as MessageRow[];

    const artifacts = this.db
      .prepare(
        `
        SELECT id, name, type, url, size
        FROM conversation_artifacts
        WHERE conversation_id = ?
        ORDER BY created_at ASC
        `
      )
      .all(conversationId) as ArtifactRow[];

    const citations = this.db
      .prepare(
        `
        SELECT
          id,
          knowledge_base_id,
          knowledge_base_name,
          document_id,
          document_name,
          snippet,
          source,
          score
        FROM conversation_citations
        WHERE conversation_id = ?
        ORDER BY score DESC
        `
      )
      .all(conversationId) as CitationRow[];

    return {
      ...this.rowToSummary({
        ...row,
        message_count: messages.length,
        last_message: messages.at(-1)?.content
      }),
      messages,
      artifacts,
      citations: citations.map(rowToCitation)
    };
  }

  async saveEvaluation(evaluation: TrainingEvaluation) {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM training_evaluations WHERE conversation_id = ?")
        .run(evaluation.conversationId);
      this.db
        .prepare(
          `
          INSERT INTO training_evaluations
            (id, conversation_id, training_type, overall_score, dimensions_json,
             diagnosis_json, suggestions_json, next_task, citations_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          evaluation.id,
          evaluation.conversationId,
          evaluation.trainingType,
          evaluation.overallScore,
          JSON.stringify(evaluation.dimensions),
          JSON.stringify(evaluation.diagnosis),
          JSON.stringify(evaluation.suggestions),
          evaluation.nextTask,
          JSON.stringify(evaluation.citations),
          evaluation.createdAt
        );
    });

    transaction();
  }

  async saveSpeakTrainingSession(conversationId: string, snapshotJson: string) {
    this.db
      .prepare(
        `
        INSERT INTO speak_training_sessions
          (conversation_id, snapshot_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
        `
      )
      .run(conversationId, snapshotJson, new Date().toISOString());
  }

  getSpeakTrainingSession(conversationId: string) {
    const row = this.db
      .prepare(
        "SELECT snapshot_json FROM speak_training_sessions WHERE conversation_id = ?"
      )
      .get(conversationId) as { snapshot_json: string } | undefined;

    return row?.snapshot_json;
  }

  getEvaluation(conversationId: string) {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM training_evaluations
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        `
      )
      .get(conversationId) as EvaluationRow | undefined;

    return row ? rowToEvaluation(row) : undefined;
  }

  listEvaluations(limit = 60) {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM training_evaluations
        ORDER BY created_at DESC
        LIMIT ?
        `
      )
      .all(limit) as EvaluationRow[];

    return rows.map(rowToEvaluation);
  }

  getGrowthSummary(): GrowthSummary {
    const conversations = this.listConversations();
    const evaluations = this.listEvaluations(200);
    const dimensionTotals = new Map<string, { total: number; count: number }>();
    const trainingTypeCounts = Object.fromEntries(
      trainingTypes.map((type) => [type, 0])
    ) as Record<TrainingType, number>;

    for (const conversation of conversations) {
      trainingTypeCounts[conversation.trainingType] += 1;
    }

    for (const evaluation of evaluations) {
      for (const dimension of evaluation.dimensions) {
        const current = dimensionTotals.get(dimension.name) || {
          total: 0,
          count: 0
        };
        current.total += dimension.score;
        current.count += 1;
        dimensionTotals.set(dimension.name, current);
      }
    }

    const dimensionAverages = [...dimensionTotals.entries()].map(
      ([name, value]) => ({
        name,
        score: Math.round(value.total / Math.max(value.count, 1)),
        comment: summarizeDimensionAverage(value.total / Math.max(value.count, 1))
      })
    );
    const weakDimensions = [...dimensionAverages]
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
    const averageScore = evaluations.length
      ? Math.round(
          evaluations.reduce((total, item) => total + item.overallScore, 0) /
            evaluations.length
        )
      : 0;
    const agentOperationStats = this.buildAgentOperationStats(conversations);
    const trainingTypeSummaries = buildTrainingTypeSummaries(conversations);
    const growthTimeline = buildGrowthTimeline(conversations);
    const evidenceRecords = buildGrowthEvidenceRecords(conversations);
    const growthStage = buildGrowthStage(conversations.length, trainingTypeCounts);
    const recommendedAction = buildRecommendedAction(weakDimensions, conversations[0]);
    const representativeArtifacts = buildRepresentativeArtifacts(conversations);
    const capabilityMatrix = buildCapabilityMatrix(
      dimensionAverages,
      agentOperationStats
    );
    const reflectionSummary = buildReflectionSummary(conversations);

    return {
      totalTrainings: conversations.length,
      averageScore,
      growthStage,
      recommendedAction,
      dimensionAverages,
      trainingTypeCounts,
      trainingTypeSummaries,
      growthTimeline,
      evidenceRecords,
      representativeArtifacts,
      capabilityMatrix,
      reflectionSummary,
      recentConversations: conversations.slice(0, 8),
      recentEvaluations: evaluations.slice(0, 8),
      weakDimensions,
      recommendedNextTask: recommendedAction.objective
    };
  }

  saveGrowthSnapshot(summary: GrowthSummary) {
    this.db
      .prepare(
        "INSERT INTO growth_snapshots (id, summary_json, created_at) VALUES (?, ?, ?)"
      )
      .run(`snapshot_${randomUUID()}`, JSON.stringify(summary), new Date().toISOString());
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        training_type TEXT NOT NULL,
        knowledge_base_ids TEXT NOT NULL,
        attachment_names TEXT NOT NULL,
        artifact_count INTEGER NOT NULL DEFAULT 0,
        citation_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS conversation_artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        url TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS conversation_citations (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL,
        knowledge_base_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_name TEXT NOT NULL,
        snippet TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS training_evaluations (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE,
        training_type TEXT NOT NULL,
        overall_score INTEGER NOT NULL,
        dimensions_json TEXT NOT NULL,
        diagnosis_json TEXT NOT NULL,
        suggestions_json TEXT NOT NULL,
        next_task TEXT NOT NULL,
        citations_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS speak_training_sessions (
        conversation_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS growth_snapshots (
        id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private buildAgentOperationStats(conversations: ConversationSummary[]) {
    const classroomDetails = conversations
      .filter((conversation) => conversation.trainingType === "模拟课堂")
      .map((conversation) => this.getConversation(conversation.id))
      .filter((conversation): conversation is ConversationDetail => Boolean(conversation));
    const allMessages = classroomDetails.flatMap((conversation) =>
      conversation.messages.map((message) => message.content)
    );
    const studentAgentActivations = allMessages.filter((content) =>
      /林一诺|陈思远|周雨桐|王子涵|赵明轩|许嘉宁|何若溪|孙浩然|李知夏|吴承泽|郑可欣|刘奕辰/.test(content)
    ).length;
    const observerTips = allMessages.filter((content) =>
      content.includes("课堂观察员")
    ).length;
    const eventAgentTriggers = allMessages.filter((content) =>
      content.includes("课堂事件")
    ).length;
    const evidenceChains = allMessages
      .filter((content) => content.includes("证据链："))
      .reduce((total, content) => total + Math.max(1, content.split(" -> ").length - 1), 0);
    const handledCount = allMessages.filter((content) => content.includes("已处理")).length;
    const pendingCount = allMessages.filter((content) => content.includes("待处理")).length;

    return {
      studentAgentActivations,
      observerTips,
      eventAgentTriggers,
      evidenceChains,
      classroomEventHandlingRate:
        handledCount + pendingCount
          ? Math.round((handledCount / (handledCount + pendingCount)) * 100)
          : 0
    };
  }

  private rowToSummary(row: ConversationRow): ConversationSummary {
    return {
      id: row.id,
      title: row.title,
      trainingType: normalizeTrainingType(row.training_type),
      messageCount: Number(row.message_count || 0),
      artifactCount: Number(row.artifact_count || 0),
      citationCount: Number(row.citation_count || 0),
      attachmentNames: parseJsonArray(row.attachment_names),
      knowledgeBaseIds: parseJsonArray(row.knowledge_base_ids),
      latestEvaluation: this.getEvaluation(row.id),
      lastMessage: row.last_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

function rowToCitation(row: CitationRow): StoredCitation {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeBaseName: row.knowledge_base_name,
    documentId: row.document_id,
    documentName: row.document_name,
    snippet: row.snippet,
    source: row.source,
    score: row.score
  };
}

function buildConversationCitationId(
  conversationId: string,
  citationId: string,
  index: number
) {
  return `citation_${conversationId}_${index}_${citationId}`;
}

function rowToEvaluation(row: EvaluationRow): TrainingEvaluation {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    trainingType: normalizeTrainingType(row.training_type),
    overallScore: row.overall_score,
    dimensions: parseJsonValue<EvaluationDimension[]>(row.dimensions_json, []),
    diagnosis: parseJsonValue<string[]>(row.diagnosis_json, []),
    suggestions: parseJsonValue<string[]>(row.suggestions_json, []),
    nextTask: row.next_task,
    citations: parseJsonValue<StoredCitation[]>(row.citations_json, []),
    createdAt: row.created_at
  };
}

export function normalizeTrainingType(value: unknown): TrainingType {
  return trainingTypes.includes(value as TrainingType)
    ? (value as TrainingType)
    : "教案诊断";
}

function parseJsonArray(value: string) {
  return parseJsonValue<string[]>(value, []).filter(
    (item): item is string => typeof item === "string"
  );
}

function parseJsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function summarizeDimensionAverage(score: number) {
  if (score >= 88) {
    return "表现稳定，可以沉淀为可复用经验。";
  }

  if (score >= 78) {
    return "基础较好，下一轮应提升细节质量。";
  }

  return "需要通过专项练习形成更清晰的方法。";
}

function buildGrowthTimeline(conversations: ConversationSummary[]): GrowthTimelineItem[] {
  return conversations.slice(0, 10).map((conversation) => {
    const evaluation = conversation.latestEvaluation;
    const weakDimensions =
      evaluation?.dimensions
        .slice()
        .sort((a, b) => a.score - b.score)
        .slice(0, 2)
        .map((dimension) => dimension.name) || [];

    return {
      id: conversation.id,
      title: conversation.title,
      trainingType: conversation.trainingType,
      score: evaluation?.overallScore || 0,
      dimensions: evaluation?.dimensions || [],
      weakDimensions,
      artifactCount: conversation.artifactCount,
      nextTask: evaluation?.nextTask || buildDefaultTimelineTask(conversation.trainingType),
      createdAt: conversation.createdAt
    };
  });
}

function buildGrowthEvidenceRecords(conversations: ConversationSummary[]): GrowthEvidenceRecord[] {
  return conversations.slice(0, 50).map((conversation) => {
    const evaluation = conversation.latestEvaluation;
    const weakDimensions =
      evaluation?.dimensions
        .slice()
        .sort((a, b) => a.score - b.score)
        .slice(0, 2)
        .map((dimension) => dimension.name) || [];

    return {
      id: conversation.id,
      title: conversation.title,
      trainingType: conversation.trainingType,
      score: evaluation?.overallScore || 0,
      dimensions: evaluation?.dimensions || [],
      weakDimensions,
      artifactCount: conversation.artifactCount,
      citationCount: conversation.citationCount,
      nextTask: evaluation?.nextTask || buildDefaultTimelineTask(conversation.trainingType),
      createdAt: conversation.createdAt
    };
  });
}

function buildGrowthStage(
  totalTrainings: number,
  trainingTypeCounts: Record<TrainingType, number>
): GrowthStage {
  if (!totalTrainings) {
    return "建立基线";
  }

  return trainingTypes.every((type) => trainingTypeCounts[type] > 0)
    ? "专项提升"
    : "补齐训练";
}

function buildTrainingTypeSummaries(
  conversations: ConversationSummary[]
): TrainingTypeGrowthSummary[] {
  return trainingTypes.map((trainingType) => {
    const matched = conversations.filter(
      (conversation) => conversation.trainingType === trainingType
    );
    const scored = matched.filter((conversation) => conversation.latestEvaluation);
    const latest = matched[0];
    const evidenceCount = matched.reduce(
      (total, conversation) =>
        total +
        conversation.attachmentNames.length +
        conversation.citationCount +
        conversation.artifactCount,
      0
    );
    const artifactCount = matched.reduce(
      (total, conversation) => total + conversation.artifactCount,
      0
    );
    const citationCount = matched.reduce(
      (total, conversation) => total + conversation.citationCount,
      0
    );
    const averageScore = scored.length
      ? Math.round(
          scored.reduce(
            (total, conversation) =>
              total + (conversation.latestEvaluation?.overallScore || 0),
            0
          ) / scored.length
        )
      : 0;

    return {
      trainingType,
      count: matched.length,
      averageScore,
      latestTitle: latest?.title,
      latestScore: latest?.latestEvaluation?.overallScore,
      evidenceCount,
      artifactCount,
      citationCount,
      status: matched.length ? "已覆盖" : "待训练",
      nextAction:
        latest?.latestEvaluation?.nextTask || buildDefaultTimelineTask(trainingType)
    };
  });
}

function buildRepresentativeArtifacts(
  conversations: ConversationSummary[]
): RepresentativeArtifact[] {
  const byType = new Map<TrainingType, ConversationSummary>();

  for (const conversation of conversations) {
    const current = byType.get(conversation.trainingType);
    const currentScore = current?.latestEvaluation?.overallScore || 0;
    const nextScore = conversation.latestEvaluation?.overallScore || 0;

    if (
      !current ||
      conversation.artifactCount > current.artifactCount ||
      nextScore > currentScore
    ) {
      byType.set(conversation.trainingType, conversation);
    }
  }

  return [...byType.values()]
    .slice(0, 4)
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      trainingType: conversation.trainingType,
      score: conversation.latestEvaluation?.overallScore || 0,
      artifactCount: conversation.artifactCount,
      citationCount: conversation.citationCount,
      reason: buildArtifactReason(conversation),
      createdAt: conversation.createdAt
    }));
}

function buildCapabilityMatrix(
  dimensionAverages: EvaluationDimension[],
  agentStats: AgentOperationStats
): CapabilityMatrixItem[] {
  const scoreOf = (...keywords: string[]) => {
    const matched = dimensionAverages.filter((dimension) =>
      keywords.some((keyword) => dimension.name.includes(keyword))
    );

    if (!matched.length) {
      return 0;
    }

    return Math.round(
      matched.reduce((total, dimension) => total + dimension.score, 0) /
        matched.length
    );
  };
  const fallback = (score: number, value: number) =>
    score || Math.max(0, Math.min(100, Math.round(value)));

  return [
    {
      name: "教学设计",
      score: fallback(scoreOf("目标", "设计", "教案", "重难点"), 62),
      evidence: "来自教案诊断中的目标、流程、板书和任务设计评价。",
      nextAction: "下一轮把教学目标、活动任务和评价标准写成一一对应关系。"
    },
    {
      name: "课堂表达",
      score: fallback(scoreOf("表达", "说课", "语言", "结构"), 60),
      evidence: "来自说课陪练中的结构完整度、表达清晰度和评委追问表现。",
      nextAction: "用 60 秒说明教材价值、学生困难和核心活动。"
    },
    {
      name: "课堂应变",
      score: fallback(
        scoreOf("互动", "应变", "评价", "反馈", "控场"),
        52 + agentStats.classroomEventHandlingRate / 2
      ),
      evidence: "来自模拟课堂中的学生回应、课堂事件和处理记录。",
      nextAction: "下一轮模拟课堂重点训练学生错误回答后的二次追问。"
    },
    {
      name: "反思改进",
      score: fallback(scoreOf("反思", "改进", "证据", "原因"), 58),
      evidence: "来自实习日志与反思中的观察证据、问题诊断和改进行动。",
      nextAction: "每篇反思至少绑定一条课堂证据和一个可验证行动。"
    },
    {
      name: "师德育人",
      score: fallback(scoreOf("师德", "育人", "公平", "关怀"), 56),
      evidence: "来自教案、课堂和反思中对学生差异、价值引导和公平评价的呈现。",
      nextAction: "补充面向不同学生的鼓励性评价语言。"
    },
  ].map((item) => ({
    ...item,
    score: Math.max(0, Math.min(100, Math.round(item.score)))
  }));
}

function buildReflectionSummary(conversations: ConversationSummary[]): ReflectionGrowthSummary {
  const reflectionConversations = conversations.filter(
    (conversation) => conversation.trainingType === "实习反思"
  );
  const latest = reflectionConversations[0];
  const evidenceCount = reflectionConversations.reduce(
    (total, conversation) =>
      total +
      conversation.attachmentNames.length +
      conversation.citationCount +
      conversation.artifactCount,
    0
  );

  return {
    totalReflections: reflectionConversations.length,
    latestTitle: latest?.title,
    latestScore: latest?.latestEvaluation?.overallScore,
    evidenceCount,
    nextAction:
      latest?.latestEvaluation?.nextTask ||
      "下一次实习反思请补充课堂照片、听课记录或学生作业，形成证据驱动复盘。"
  };
}

function buildDefaultTimelineTask(trainingType: TrainingType) {
  if (trainingType === "实习反思") {
    return "补充课堂证据，再按建议优化反思。";
  }

  if (trainingType === "模拟课堂") {
    return "回看课堂事件与观察员建议，完成一次针对性追问训练。";
  }

  if (trainingType === "说课陪练") {
    return "围绕评委追问补充学情和目标依据。";
  }

  return "根据诊断意见修订教学目标、流程和评价任务。";
}

function buildArtifactReason(conversation: ConversationSummary) {
  if (conversation.trainingType === "实习反思") {
    return "可作为实习复盘与师德育人反思的代表成果。";
  }

  if (conversation.trainingType === "模拟课堂") {
    return "记录学生回应、课堂事件、观察建议与课后复盘。";
  }

  if (conversation.trainingType === "说课陪练") {
    return "可体现师范生表达结构、临场回应和专家追问训练。";
  }

  return "可展示教学设计能力和课程资源引用情况。";
}

function buildRecommendedAction(
  weakDimensions: EvaluationDimension[],
  latestConversation?: ConversationSummary
): RecommendedAction {
  const weakest = weakDimensions[0]?.name;
  const actionFor = (trainingType: TrainingType, reason: string, objective: string): RecommendedAction => ({
    trainingType,
    reason,
    objective,
    completionCriteria: "完成本轮训练并生成一份带评价的记录。",
    prompt: trainingPromptFor(trainingType)
  });

  if (!weakest) {
    return actionFor(
      "教案诊断",
      "尚未沉淀带评价的训练记录，需要先建立能力基线。",
      "先完成一次教案诊断，建立第一份能力基线。"
    );
  }

  if (/课堂表达|说课|语言|结构|答辩/.test(weakest)) {
    return actionFor(
      "说课陪练",
      `「${weakest}」是当前最需提升的能力，适合通过说课演练与追问训练改善。`,
      `完成一次围绕「${weakest}」的说课陪练，重点根据追问补充表达结构与理论依据。`
    );
  }

  if (/课堂互动|互动|应变|评价|反馈|控场|追问/.test(weakest)) {
    return actionFor(
      "模拟课堂",
      `「${weakest}」得分最低，需要在课堂情境中练习回应学生与连续追问。`,
      "完成一次模拟课堂追问训练，至少根据学生回答做出两次针对性追问。"
    );
  }

  if (/教学反思|反思改进|反思|改进|证据|闭环/.test(weakest)) {
    return actionFor(
      "实习反思",
      `「${weakest}」需要把课堂现象转化为可验证的改进行动。`,
      "完成一篇实习反思，明确问题、课堂证据与下一次改进动作。"
    );
  }

  if (/教学设计|师德育人|目标|设计|教案|流程|任务|重难点|教材|学情|活动/.test(weakest)) {
    return actionFor(
      "教案诊断",
      `「${weakest}」需要回到教学设计中进行针对性修订。`,
      `完成一次教案诊断，围绕「${weakest}」修订教学目标、流程或评价任务。`
    );
  }

  const trainingType = latestConversation?.trainingType || "教案诊断";
  return actionFor(
    trainingType,
    `当前最弱能力为「${weakest}」，延续最近训练更利于形成可比较的改进证据。`,
    latestConversation
      ? `延续「${latestConversation.title}」，围绕「${weakest}」完成一轮修改后再评价。`
      : `围绕「${weakest}」完成一次专项训练。`
  );
}

function trainingPromptFor(trainingType: TrainingType) {
  if (trainingType === "说课陪练") {
    return "陪我练习说课，请先给我一份说课结构，再模拟评委追问。";
  }

  if (trainingType === "模拟课堂") {
    return "模拟一轮课堂提问，请围绕学生可能的回答连续追问。";
  }

  if (trainingType === "实习反思") {
    return "帮我整理实习日志与反思，突出课堂观察、问题分析和改进计划。";
  }

  return "帮我生成一份完整教案，包含教学目标、重难点、流程、板书和课后反思。";
}

function buildRecommendedTask(
  weakDimensions: EvaluationDimension[],
  latestConversation?: ConversationSummary
) {
  const weakest = weakDimensions[0]?.name;

  if (!weakest) {
    return "先完成一次教案诊断，建立第一份能力基线。";
  }

  if (weakest === "课堂互动") {
    return "围绕最近一节课做一次模拟课堂追问训练，重点练习学生回答后的二次追问。";
  }

  if (weakest === "反思改进") {
    return "基于最近训练记录写一篇实习反思，要求明确问题、证据与下一次改进动作。";
  }

  if (weakest === "师德育人") {
    return "选择一个教学片段，补充学科育人、价值引导与教师言行示范设计。";
  }

  return latestConversation
    ? `延续「${latestConversation.title}」，针对「${weakest}」做一轮修改后再评价。`
    : `围绕「${weakest}」完成一次专项训练。`;
}
