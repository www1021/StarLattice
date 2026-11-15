import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ownerScope, ownerValue } from "./auth/context.js";
import { ensureOwnerColumnsFor, PERSONAL_TABLES } from "./auth/ownership.js";
import { OfficeParser, type SupportedFileType } from "officeparser";
import { PDFParse } from "pdf-parse";
import {
  assertCleanText,
  decodeTextBuffer,
  normalizeUploadName,
  TextEncodingError
} from "./textEncoding.js";

export type KnowledgeBaseSummary = {
  id: string;
  name: string;
  source: KnowledgeSource;
  providerStatus?: KnowledgeProviderStatus;
  externalId?: string;
  documentCount: number;
  createdAt: string;
};

export type KnowledgeDocumentSummary = {
  id: string;
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
  chunkCount: number;
  resourceType: KnowledgeResourceType;
  subject?: string;
  schoolStage?: string;
  tags: string[];
  createdAt: string;
};

export type KnowledgeResourceType =
  | "课程标准"
  | "教材/课件"
  | "优秀课例"
  | "课堂证据"
  | "教研资料"
  | "其他";

export type KnowledgeDocumentMetadata = {
  resourceType?: KnowledgeResourceType;
  subject?: string;
  schoolStage?: string;
  tags?: string[];
};

export type KnowledgeChunkSummary = {
  id: string;
  documentId: string;
  index: number;
  content: string;
};

export type KnowledgeCitation = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentName: string;
  snippet: string;
  source: KnowledgeSource;
  score: number;
};

export type KnowledgeSource = "local" | "ima" | "external";

export type KnowledgeProviderStatus =
  | "connected"
  | "not_configured"
  | "error"
  | "syncing";

export type KnowledgeProviderInfo = {
  id: KnowledgeSource;
  name: string;
  status: KnowledgeProviderStatus;
  description: string;
  baseCount?: number;
  message?: string;
};

export type StarterKnowledgePack = {
  id: string;
  name: string;
  description: string;
  recommendedFor: string[];
  documentCount: number;
};

export type KnowledgeProvider = {
  listBases(): KnowledgeBaseSummary[];
  createBase(name: string): KnowledgeBaseSummary;
  renameBase(knowledgeBaseId: string, name: string): KnowledgeBaseSummary;
  deleteBase(knowledgeBaseId: string): void;
  listDocuments(knowledgeBaseId: string): KnowledgeDocumentSummary[];
  listDocumentChunks(documentId: string): KnowledgeChunkSummary[];
  addDocument(
    knowledgeBaseId: string,
    file: Express.Multer.File,
    metadata?: KnowledgeDocumentMetadata
  ): Promise<KnowledgeDocumentSummary>;
  deleteDocument(knowledgeBaseId: string, documentId: string): void;
  search(options: {
    query: string;
    knowledgeBaseIds: string[];
    topK?: number;
  }): KnowledgeCitation[];
};

export type IMAConnectionTestResult = {
  ok: boolean;
  status: KnowledgeProviderStatus;
  message: string;
  baseCount?: number;
};

type ChunkRow = {
  id: string;
  base_id: string;
  base_name: string;
  document_id: string;
  document_name: string;
  content: string;
  rank?: number;
  snippet?: string;
};

const defaultKnowledgeBaseName = "默认知识库";
const supportedDocumentExtensions = new Set([
  "pdf",
  "txt",
  "md",
  "csv",
  "json",
  "docx",
  "xlsx",
  "pptx"
]);
const maxKnowledgeDocumentBytes = 10 * 1024 * 1024;
const chunkSize = 900;
const chunkOverlap = 140;
const knowledgeResourceTypes: KnowledgeResourceType[] = [
  "课程标准",
  "教材/课件",
  "优秀课例",
  "课堂证据",
  "教研资料",
  "其他"
];

const starterKnowledgePacks: Array<StarterKnowledgePack & {
  documents: Array<{
    name: string;
    content: string;
    metadata: Required<KnowledgeDocumentMetadata>;
  }>;
}> = [
  {
    id: "lesson-design-demo",
    name: "教学设计示例包",
    description: "用一组示例材料体验如何把目标、活动和评价写进教案与说课。",
    recommendedFor: ["教案诊断", "说课陪练", "模拟课堂"],
    documentCount: 3,
    documents: [
      {
        name: "示例课程依据：分数的意义.txt",
        content: "本示例围绕‘分数的意义’设计。学习重点是让学生理解分数表示整体与部分的关系，并能在具体情境中解释分子、分母的含义。教学时应从熟悉的分物、测量和图形情境出发，引导学生用图示、语言和算式多种方式表达理解。",
        metadata: { resourceType: "课程标准", subject: "数学", schoolStage: "初中", tags: ["示例", "课程依据", "分数"] }
      },
      {
        name: "示例课例：任务驱动与追问.txt",
        content: "课堂活动可设置为：四人小组把一张纸平均分成四份，用其中三份表示自己的选择。学生需要说清‘谁被平均分’、‘取了几份’和‘分数各部分表示什么’。教师先追问学生的表示理由，再邀请同伴补充，最后用图示归纳。评价关注学生能否解释分数含义，而不只关注是否写对符号。",
        metadata: { resourceType: "优秀课例", subject: "数学", schoolStage: "初中", tags: ["示例", "活动设计", "追问"] }
      },
      {
        name: "示例评价：目标活动评价对齐.txt",
        content: "目标、活动和评价需要一一对应：若目标是解释分数意义，活动应让学生在情境中表达整体与部分关系，评价则应记录学生能否说出理由。对回答不完整的学生，使用‘你说的整体是什么’‘还差哪一部分信息’等追问提供支架。",
        metadata: { resourceType: "教研资料", subject: "数学", schoolStage: "初中", tags: ["示例", "评价", "教学设计"] }
      }
    ]
  },
  {
    id: "reflection-demo",
    name: "实习反思示例包",
    description: "用课堂片段、学生回应和改进行动体验证据驱动的实习反思。",
    recommendedFor: ["实习反思", "模拟课堂", "说课陪练"],
    documentCount: 3,
    documents: [
      {
        name: "示例课堂记录：学生沉默后的追问.txt",
        content: "课堂提问后，多名学生没有立即回应。教师没有直接给出答案，而是把问题拆分为‘先找整体，再看分成几份’，并请学生用手势表示。随后一名学生能够说出分母表示平均分成的份数。该片段可作为分析提问难度与支架是否合适的证据。",
        metadata: { resourceType: "课堂证据", subject: "数学", schoolStage: "初中", tags: ["示例", "课堂观察", "学生回应"] }
      },
      {
        name: "示例反思框架：证据原因行动.txt",
        content: "反思先写清观察到的事实，再分析可能原因，最后提出下一次可验证的行动。不要只写‘课堂气氛不够活跃’，应写成‘第一次开放提问后约十秒无人回应；下次先提供图示和同伴讨论一分钟，再邀请学生表达理由’。",
        metadata: { resourceType: "教研资料", subject: "通用", schoolStage: "通用", tags: ["示例", "实习反思", "改进行动"] }
      },
      {
        name: "示例育人表达：公平参与与鼓励性反馈.txt",
        content: "课堂评价应兼顾不同基础学生。对暂未完整回答的学生，先肯定其已说出的线索，再通过追问帮助补全；对表达积极的学生，邀请其说明理由而非只给出结论。这样能让公平参与和尊重差异落实为可观察的课堂行为。",
        metadata: { resourceType: "教研资料", subject: "通用", schoolStage: "通用", tags: ["示例", "师德育人", "评价"] }
      }
    ]
  },
  {
    id: "business-metrics-demo",
    name: "经营分析指标口径包",
    description: "统一销售额、退款、毛利额与毛利率的计算口径，避免报告口径不一致。",
    recommendedFor: ["经营分析", "指标口径", "报告复核"],
    documentCount: 3,
    documents: [
      {
        name: "指标口径：销售额、退款与毛利.txt",
        content: "毛销售额是订单原始金额之和；退款额必须从毛销售额中扣除，得到净销售额。毛利额 = 净销售额 − 销货成本，毛利率 = 毛利额 ÷ 净销售额。任何以毛销售额计算毛利额的口径都会高估经营表现，报告初稿若出现这类数字，应由验证环节拦截并重算。",
        metadata: { resourceType: "教研资料", subject: "经营分析", schoolStage: "通用", tags: ["经营分析", "指标口径", "毛利额"] }
      },
      {
        name: "分析规范：区域与品类对比.txt",
        content: "区域与品类汇总统一使用净额口径：先按维度汇总净销售额，再汇总销货成本并计算毛利额。区域退款应归属到产生退款的区域；默认按净销售额从高到低排序，必要时补充销量与退款额，避免只看金额忽略结构变化。",
        metadata: { resourceType: "教研资料", subject: "经营分析", schoolStage: "通用", tags: ["经营分析", "区域", "品类"] }
      },
      {
        name: "报告结构：结论到行动建议.txt",
        content: "经营分析报告按结论、数据概况、区域表现、品类表现、毛利核算、口径说明组织。每个结论都应能追溯到工具返回的数字；先说明本期整体表现，再指出增长来源与拖累项，最后给出可执行的下一步行动，例如调整品类结构或核查高退款渠道。",
        metadata: { resourceType: "教研资料", subject: "经营分析", schoolStage: "通用", tags: ["经营分析", "报告", "行动建议"] }
      }
    ]
  }
];

export class LocalKnowledgeProvider implements KnowledgeProvider {
  private readonly db: Database.Database;

  constructor(dbPath = path.resolve("data", "knowledge.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  /** 关闭底层连接；测试用完临时库时调用，避免 Windows 上文件被占用。 */
  close() {
    if (this.db.open) {
      this.db.close();
    }
  }

  listBases(): KnowledgeBaseSummary[] {
    const owner = ownerScope("bases");
    return this.db
      .prepare(
        `
        SELECT
          bases.id,
          bases.name,
          bases.source,
          bases.created_at AS createdAt,
          COUNT(documents.id) AS documentCount
        FROM knowledge_bases AS bases
        LEFT JOIN knowledge_documents AS documents
          ON documents.base_id = bases.id
        WHERE ${owner.condition}
        GROUP BY bases.id
        ORDER BY bases.created_at ASC
        `
      )
      .all(...owner.params) as KnowledgeBaseSummary[];
  }

  createBase(name: string): KnowledgeBaseSummary {
    const trimmedName = name.trim() || defaultKnowledgeBaseName;
    const owner = ownerScope("knowledge_bases");
    const existing = this.db
      .prepare(`SELECT id FROM knowledge_bases WHERE name = ?${owner.and}`)
      .get(trimmedName, ...owner.params) as { id: string } | undefined;

    if (existing) {
      return this.listBases().find((base) => base.id === existing.id)!;
    }

    const id = `kb_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO knowledge_bases (id, name, source, created_at, owner_id) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, trimmedName, "local", createdAt, ownerValue());

    return {
      id,
      name: trimmedName,
      source: "local",
      documentCount: 0,
      createdAt
    };
  }

  listStarterPacks(): StarterKnowledgePack[] {
    return starterKnowledgePacks.map(({ documents: _documents, ...pack }) => pack);
  }

  importStarterPack(packId: string): KnowledgeBaseSummary {
    const pack = starterKnowledgePacks.find((item) => item.id === packId);

    if (!pack) {
      throw new KnowledgeError("示例资料包不存在。", 404);
    }

    const base = this.createBase(`我的资料包：${pack.name}`);
    const existingNames = new Set(this.listDocuments(base.id).map((document) => document.name));

    for (const document of pack.documents) {
      if (!existingNames.has(document.name)) {
        this.addTextDocument(base.id, document.name, document.content, document.metadata);
      }
    }

    return this.listBases().find((item) => item.id === base.id)!;
  }

  listDocuments(knowledgeBaseId: string): KnowledgeDocumentSummary[] {
    this.ensureBase(knowledgeBaseId);
    return (
      this.db
        .prepare(
        `
        SELECT
          documents.id,
          documents.base_id AS knowledgeBaseId,
          documents.name,
          documents.type,
          documents.size,
          documents.created_at AS createdAt,
          documents.resource_type AS resourceType,
          documents.subject,
          documents.school_stage AS schoolStage,
          documents.tags,
          COUNT(chunks.id) AS chunkCount
        FROM knowledge_documents AS documents
        LEFT JOIN knowledge_chunks AS chunks
          ON chunks.document_id = documents.id
        WHERE documents.base_id = ?
        GROUP BY documents.id
        ORDER BY documents.created_at DESC
        `
        )
        .all(knowledgeBaseId)
        .map((row) => normalizeDocumentSummary(row as Record<string, unknown>))
    ) as KnowledgeDocumentSummary[];
  }

  listDocumentChunks(documentId: string): KnowledgeChunkSummary[] {
    const parent = this.db
      .prepare("SELECT base_id FROM knowledge_documents WHERE id = ?")
      .get(documentId) as { base_id: string } | undefined;
    if (!parent) {
      return [];
    }
    this.ensureBase(parent.base_id);
    return this.db
      .prepare(
        `
        SELECT
          id,
          document_id AS documentId,
          chunk_index AS "index",
          content
        FROM knowledge_chunks
        WHERE document_id = ?
        ORDER BY chunk_index ASC
        LIMIT 24
        `
      )
      .all(documentId) as KnowledgeChunkSummary[];
  }

  renameBase(knowledgeBaseId: string, name: string) {
    this.ensureBase(knowledgeBaseId);
    const trimmedName = name.trim();

    if (!trimmedName) {
      throw new KnowledgeError("资料库名称不能为空。", 400);
    }

    try {
      this.db
        .prepare("UPDATE knowledge_bases SET name = ? WHERE id = ?")
        .run(trimmedName, knowledgeBaseId);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new KnowledgeError("已存在同名资料库，请换一个名称。", 409);
      }
      throw error;
    }

    return this.listBases().find((base) => base.id === knowledgeBaseId)!;
  }

  deleteBase(knowledgeBaseId: string) {
    this.ensureBase(knowledgeBaseId);

    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM knowledge_chunks_fts WHERE base_id = ?").run(knowledgeBaseId);
      this.db.prepare("DELETE FROM knowledge_chunks WHERE base_id = ?").run(knowledgeBaseId);
      this.db.prepare("DELETE FROM knowledge_documents WHERE base_id = ?").run(knowledgeBaseId);
      this.db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(knowledgeBaseId);
    });

    transaction();

    if (this.listBases().length === 0) {
      this.createBase(defaultKnowledgeBaseName);
    }
  }

  async addDocument(
    knowledgeBaseId: string,
    file: Express.Multer.File,
    metadata: KnowledgeDocumentMetadata = {}
  ) {
    this.ensureBase(knowledgeBaseId);
    validateKnowledgeFile(file);

    const extractedText = await extractKnowledgeText(file);
    const chunks = splitTextIntoChunks(extractedText);

    if (chunks.length === 0) {
      throw new KnowledgeError("文件没有提取到可用于知识库的文本。", 400);
    }

    const documentId = `doc_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const fileName = normalizeUploadName(file.originalname);
    const extension = getFileExtension(fileName);
    const normalizedMetadata = normalizeDocumentMetadata(metadata);

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO knowledge_documents
            (id, base_id, name, type, size, resource_type, subject, school_stage, tags, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          documentId,
          knowledgeBaseId,
          fileName,
          extension,
          file.size,
          normalizedMetadata.resourceType,
          normalizedMetadata.subject,
          normalizedMetadata.schoolStage,
          JSON.stringify(normalizedMetadata.tags),
          createdAt
        );

      const insertChunk = this.db.prepare(
        `
        INSERT INTO knowledge_chunks
          (id, base_id, document_id, document_name, chunk_index, content)
        VALUES (?, ?, ?, ?, ?, ?)
        `
      );
      const insertFts = this.db.prepare(
        `
        INSERT INTO knowledge_chunks_fts
          (chunk_id, base_id, document_id, document_name, content)
        VALUES (?, ?, ?, ?, ?)
        `
      );

      chunks.forEach((content, index) => {
        const chunkId = `chunk_${randomUUID()}`;
        insertChunk.run(
          chunkId,
          knowledgeBaseId,
          documentId,
          fileName,
          index,
          content
        );
        insertFts.run(
          chunkId,
          knowledgeBaseId,
          documentId,
          fileName,
          content
        );
      });
    });

    transaction();

    return {
      id: documentId,
      knowledgeBaseId,
      name: fileName,
      type: extension,
      size: file.size,
      chunkCount: chunks.length,
      ...normalizedMetadata,
      createdAt
    };
  }

  private addTextDocument(
    knowledgeBaseId: string,
    name: string,
    content: string,
    metadata: KnowledgeDocumentMetadata
  ) {
    const chunks = splitTextIntoChunks(content);
    const documentId = `doc_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const normalizedMetadata = normalizeDocumentMetadata(metadata);

    const transaction = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO knowledge_documents
          (id, base_id, name, type, size, resource_type, subject, school_stage, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        documentId,
        knowledgeBaseId,
        name,
        "txt",
        Buffer.byteLength(content, "utf8"),
        normalizedMetadata.resourceType,
        normalizedMetadata.subject,
        normalizedMetadata.schoolStage,
        JSON.stringify(normalizedMetadata.tags),
        createdAt
      );
      const insertChunk = this.db.prepare(
        `INSERT INTO knowledge_chunks
          (id, base_id, document_id, document_name, chunk_index, content)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insertFts = this.db.prepare(
        `INSERT INTO knowledge_chunks_fts
          (chunk_id, base_id, document_id, document_name, content)
         VALUES (?, ?, ?, ?, ?)`
      );

      chunks.forEach((chunk, index) => {
        const chunkId = `chunk_${randomUUID()}`;
        insertChunk.run(chunkId, knowledgeBaseId, documentId, name, index, chunk);
        insertFts.run(chunkId, knowledgeBaseId, documentId, name, chunk);
      });
    });

    transaction();
  }

  deleteDocument(knowledgeBaseId: string, documentId: string) {
    this.ensureBase(knowledgeBaseId);

    const existing = this.db
      .prepare("SELECT id FROM knowledge_documents WHERE id = ? AND base_id = ?")
      .get(documentId, knowledgeBaseId);

    if (!existing) {
      throw new KnowledgeError("文档不存在。", 404);
    }

    const transaction = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM knowledge_chunks_fts WHERE document_id = ?")
        .run(documentId);
      this.db
        .prepare("DELETE FROM knowledge_chunks WHERE document_id = ?")
        .run(documentId);
      this.db
        .prepare("DELETE FROM knowledge_documents WHERE id = ? AND base_id = ?")
        .run(documentId, knowledgeBaseId);
    });

    transaction();
  }

  search({
    query,
    knowledgeBaseIds,
    topK = 6
  }: {
    query: string;
    knowledgeBaseIds: string[];
    topK?: number;
  }): KnowledgeCitation[] {
    const trimmedQuery = query.trim();

    if (!trimmedQuery || knowledgeBaseIds.length === 0) {
      return [];
    }

    // 检索入口也要挡一道：请求里带别人的资料库 id 时直接忽略，
    // 否则只靠前端传 id 就能搜出别人的文档片段。
    const allowed = new Set(this.listBases().map((base) => base.id));
    const uniqueBaseIds = [...new Set(knowledgeBaseIds)].filter((id) =>
      allowed.has(id)
    );
    if (uniqueBaseIds.length === 0) {
      return [];
    }
    return this.searchChunks(trimmedQuery, uniqueBaseIds, topK);
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        resource_type TEXT NOT NULL DEFAULT '其他',
        subject TEXT,
        school_stage TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_name TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        base_id UNINDEXED,
        document_id UNINDEXED,
        document_name,
        content,
        tokenize = 'unicode61'
      );
    `);

    this.migrateBaseNameUniqueness();
    this.ensureDocumentColumn("resource_type", "TEXT NOT NULL DEFAULT '其他'");
    this.ensureDocumentColumn("subject", "TEXT");
    this.ensureDocumentColumn("school_stage", "TEXT");
    this.ensureDocumentColumn("tags", "TEXT NOT NULL DEFAULT '[]'");
    ensureOwnerColumnsFor(this.db, PERSONAL_TABLES.knowledge);

    // 旧库的 name 是全局唯一。多账号后这会让 A 建「备课资料」挡住 B，
    // 也会在成员删掉自己最后一个库、要补「默认知识库」时撞上 owner 的同名库。
    // 改成「同一账号内不重名」，NULL 归属视为同一个后台账号。
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_knowledge_bases_name_owner
       ON knowledge_bases(name, IFNULL(owner_id, ''))`
    );

    if (this.listBases().length === 0) {
      this.createBase(defaultKnowledgeBaseName);
    }
  }

  /**
   * 老的 knowledge_bases 带列级 UNIQUE(name)，SQLite 不允许直接删这种自动索引，
   * 只能重建表。重建期间必须临时关外键，否则 DROP 父表会级联清掉文档和分块。
   */
  private migrateBaseNameUniqueness() {
    const indexes = this.db
      .prepare("PRAGMA index_list(knowledge_bases)")
      .all() as Array<{ name: string; unique: number }>;
    const legacy = indexes.some((index) => {
      if (!index.unique || !index.name.startsWith("sqlite_autoindex_")) {
        return false;
      }
      const columns = this.db
        .prepare(`PRAGMA index_info(${index.name})`)
        .all() as Array<{ name: string }>;
      return columns.length === 1 && columns[0].name === "name";
    });
    if (!legacy) {
      return;
    }

    const columns = this.db
      .prepare("PRAGMA table_info(knowledge_bases)")
      .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
    const definitions = columns
      .map((column) => {
        const parts = [column.name, column.type];
        if (column.pk) {
          parts.push("PRIMARY KEY");
        } else if (column.notnull) {
          parts.push("NOT NULL");
        }
        if (column.dflt_value !== null) {
          parts.push(`DEFAULT ${column.dflt_value}`);
        }
        return parts.join(" ");
      })
      .join(", ");
    const names = columns.map((column) => column.name).join(", ");

    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE knowledge_bases__migrated (${definitions})`);
        this.db.exec(
          `INSERT INTO knowledge_bases__migrated (${names}) SELECT ${names} FROM knowledge_bases`
        );
        this.db.exec("DROP TABLE knowledge_bases");
        this.db.exec("ALTER TABLE knowledge_bases__migrated RENAME TO knowledge_bases");
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  private ensureBase(knowledgeBaseId: string) {
    const owner = ownerScope("knowledge_bases");
    const base = this.db
      .prepare(`SELECT id FROM knowledge_bases WHERE id = ?${owner.and}`)
      .get(knowledgeBaseId, ...owner.params);

    if (!base) {
      throw new KnowledgeError("知识库不存在。", 404);
    }
  }

  private ensureDocumentColumn(name: string, definition: string) {
    const columns = this.db.prepare("PRAGMA table_info(knowledge_documents)").all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE knowledge_documents ADD COLUMN ${name} ${definition}`);
    }
  }

  /**
   * 中文没有空格，FTS5 的 unicode61 分词器会把连续汉字当成一个 token，中文查询几乎无命中，
   * 旧回退又按单字覆盖率打分，常见字会把无关文档顶到前面。这里改为确定性词法检索：
   * 中文按二元组、英文按词，按 IDF 加权，同一文档只保留最高分块。
   * 本地教研资料规模有限（分块上限 20000），线性扫描可接受；超限时退化为最近分块。
   */
  private searchChunks(query: string, baseIds: string[], topK: number) {
    const basePlaceholders = baseIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          base_id,
          (SELECT name FROM knowledge_bases WHERE id = base_id) AS base_name,
          document_id,
          document_name,
          content
        FROM knowledge_chunks
        WHERE base_id IN (${basePlaceholders})
        ORDER BY rowid DESC
        LIMIT 20000
        `
      )
      .all(...baseIds) as ChunkRow[];

    if (rows.length === 0) {
      return [];
    }

    const grams = queryGrams(query);
    if (grams.length === 0) {
      return [];
    }

    const documentFrequency = new Map<string, number>();
    for (const row of rows) {
      const text = row.content.toLowerCase();
      for (const gram of grams) {
        if (text.includes(gram)) {
          documentFrequency.set(gram, (documentFrequency.get(gram) ?? 0) + 1);
        }
      }
    }

    const scored = rows
      .map((row) => {
        const text = row.content.toLowerCase();
        let score = 0;
        for (const gram of grams) {
          if (!text.includes(gram)) continue;
          const df = documentFrequency.get(gram) ?? 0;
          if (df === 0) continue;
          const idf = Math.log(1 + rows.length / (1 + df));
          const tf = Math.min(8, countOccurrences(text, gram));
          score += idf * (1 + Math.log(tf));
        }
        return { row, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);

    const byDocument = new Map<string, { row: ChunkRow; score: number }>();
    for (const item of scored) {
      if (!byDocument.has(item.row.document_id)) {
        byDocument.set(item.row.document_id, item);
      }
    }

    const ranked = [...byDocument.values()];
    const maxScore = ranked[0]?.score ?? 1;
    // 只靠一个通用二元组命中的文档不进引用列表，避免 topK 被弱相关文档填满。
    const unique = ranked
      .filter((item, index) => index === 0 || item.score >= maxScore * 0.2)
      .slice(0, topK);
    return unique.map((item) =>
      rowToCitation(
        {
          ...item.row,
          snippet: makeSnippet(query, item.row.content)
        },
        Math.round((item.score / maxScore) * 100) / 100
      )
    );
  }
}

export class IMAKnowledgeProvider {
  private readonly baseUrl: string;
  private cachedBases: KnowledgeBaseSummary[] = [];
  private lastError = "";

  constructor() {
    this.baseUrl = trimTrailingSlash(
      process.env.IMA_BASE_URL || "https://ima.qq.com/openapi/wiki/v1"
    );
  }

  isConfigured() {
    return Boolean(process.env.IMA_API_KEY && process.env.IMA_CLIENT_ID);
  }

  getStatus(): KnowledgeProviderInfo {
    if (!this.isConfigured()) {
      return {
        id: "ima",
        name: "IMA 知识库",
        status: "not_configured",
        description: "配置 IMA_API_KEY 与 IMA_CLIENT_ID 后可连接外部知识库。",
        message: "未配置 IMA 凭据"
      };
    }

    return {
      id: "ima",
      name: "IMA 知识库",
      status: this.lastError ? "error" : "connected",
      description: "从 IMA 同步知识库列表，并在聊天与教案生成中引用。",
      baseCount: this.cachedBases.length,
      message: this.lastError || "已配置 IMA 凭据"
    };
  }

  async testConnection(): Promise<IMAConnectionTestResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        status: "not_configured",
        message: "未配置 IMA_API_KEY 或 IMA_CLIENT_ID。"
      };
    }

    try {
      const bases = await this.fetchBases();
      this.cachedBases = bases;
      this.lastError = "";

      return {
        ok: true,
        status: "connected",
        message: `IMA 连接成功，发现 ${bases.length} 个知识库。`,
        baseCount: bases.length
      };
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "IMA 连接失败。";

      return {
        ok: false,
        status: "error",
        message: this.lastError
      };
    }
  }

  async syncBases() {
    const result = await this.testConnection();

    return {
      ...result,
      bases: this.cachedBases
    };
  }

  async listBases() {
    if (!this.isConfigured()) {
      return [];
    }

    if (this.cachedBases.length) {
      return this.cachedBases;
    }

    try {
      this.cachedBases = await this.fetchBases();
      this.lastError = "";
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "IMA 知识库列表加载失败。";
      return [];
    }

    return this.cachedBases;
  }

  listDocuments(_knowledgeBaseId: string): KnowledgeDocumentSummary[] {
    return [];
  }

  listDocumentChunks(_documentId: string): KnowledgeChunkSummary[] {
    return [];
  }

  async search({
    query,
    knowledgeBaseIds,
    topK = 6
  }: {
    query: string;
    knowledgeBaseIds: string[];
    topK?: number;
  }): Promise<KnowledgeCitation[]> {
    const trimmedQuery = query.trim();

    if (!this.isConfigured() || !trimmedQuery || knowledgeBaseIds.length === 0) {
      return [];
    }

    const citations: KnowledgeCitation[] = [];

    for (const baseId of knowledgeBaseIds) {
      const externalBaseId = getExternalImaBaseId(baseId);

      if (!externalBaseId) {
        continue;
      }

      try {
        citations.push(
          ...(await this.searchOneBase(trimmedQuery, baseId, externalBaseId, topK))
        );
      } catch (error) {
        this.lastError =
          error instanceof Error ? error.message : "IMA 检索失败。";
      }
    }

    return citations
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }

  private async fetchBases(): Promise<KnowledgeBaseSummary[]> {
    const payload = await this.request("search_knowledge_base", {
      query: "",
      query_user: true,
      cursor: "",
      limit: 20
    });
    const items = readImaItems(payload);

    return items
      .map((item, index): KnowledgeBaseSummary | undefined => {
        const externalId = readFirstString(item, [
          "kb_id",
          "knowledge_base_id",
          "knowledgeBaseId",
          "id",
          "resource_id",
          "base_id"
        ]);
        const name =
          readFirstString(item, [
            "kb_name",
            "name",
            "title",
            "knowledge_base_name",
            "knowledgeBaseName"
          ]) || `IMA 知识库 ${index + 1}`;

        if (!externalId) {
          return undefined;
        }

        return {
          id: formatImaBaseId(externalId),
          externalId,
          name,
          source: "ima" as const,
          providerStatus: "connected" as const,
          documentCount:
            Number(
              readFirstValue(item, [
                "content_count",
                "document_count",
                "doc_count",
                "count"
              ])
            ) || 0,
          createdAt:
            readFirstString(item, ["created_at", "create_time", "updated_at"]) ||
            new Date().toISOString()
        };
      })
      .filter((item): item is KnowledgeBaseSummary => Boolean(item));
  }

  private async searchOneBase(
    query: string,
    baseId: string,
    externalBaseId: string,
    topK: number
  ) {
    if (this.cachedBases.length === 0) {
      await this.listBases();
    }

    const payload = await this.request("search_knowledge", {
      query,
      knowledge_base_id: externalBaseId,
      cursor: "",
      limit: Math.max(1, Math.min(topK, 10))
    });
    const baseName =
      this.cachedBases.find((base) => base.id === baseId)?.name || "IMA 知识库";

    return readImaItems(payload)
      .map((item, index) => {
        const documentId =
          readFirstString(item, [
            "media_id",
            "id",
            "resource_id",
            "doc_id",
            "document_id"
          ]) ||
          `${externalBaseId}_${index}`;
        const documentName =
          readFirstString(item, ["title", "name", "document_name", "file_name"]) ||
          "IMA 资料";
        const snippet =
          readFirstString(item, [
            "snippet",
            "highlight_content",
            "content",
            "summary",
            "text"
          ]) ||
          documentName ||
          JSON.stringify(item).slice(0, 180);
        const scoreValue = Number(readFirstValue(item, ["score", "rank"]));

        return {
          id: `ima_${documentId}_${index}`,
          knowledgeBaseId: baseId,
          knowledgeBaseName: baseName,
          documentId,
          documentName,
          snippet: snippet.replace(/\s+/g, " ").trim(),
          source: "ima" as const,
          score: Number.isFinite(scoreValue) ? scoreValue : 0.7 - index * 0.03
        };
      })
      .filter((item) => item.snippet)
      .slice(0, topK);
  }

  private async request(pathname: string, body: Record<string, unknown>) {
    const response = await fetch(`${this.baseUrl}/${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ima-openapi-apikey": process.env.IMA_API_KEY || "",
        "ima-openapi-clientid": process.env.IMA_CLIENT_ID || ""
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new KnowledgeError(
        readFirstString(payload, ["message", "msg", "error"]) ||
          `IMA 请求失败（${response.status}）。`,
        response.status
      );
    }

    const code = readFirstValue(payload, ["code", "errcode", "status"]);

    if (code !== undefined && code !== 0 && code !== "0" && code !== "success") {
      throw new KnowledgeError(
        readFirstString(payload, ["message", "msg", "error"]) || "IMA 返回异常。",
        502
      );
    }

    return payload;
  }
}

export class KnowledgeProviderRegistry {
  constructor(
    private readonly localProvider: LocalKnowledgeProvider,
    private readonly imaProvider: IMAKnowledgeProvider
  ) {}

  async listBases() {
    const localBases = this.localProvider.listBases();
    const imaBases = await this.imaProvider.listBases();

    return [...localBases, ...imaBases];
  }

  createBase(name: string) {
    return this.localProvider.createBase(name);
  }

  listStarterPacks() {
    return this.localProvider.listStarterPacks();
  }

  importStarterPack(packId: string) {
    return this.localProvider.importStarterPack(packId);
  }

  renameBase(knowledgeBaseId: string, name: string) {
    if (isImaBaseId(knowledgeBaseId)) {
      throw new KnowledgeError("IMA 资料库请在 IMA 平台中管理。", 400);
    }

    return this.localProvider.renameBase(knowledgeBaseId, name);
  }

  deleteBase(knowledgeBaseId: string) {
    if (isImaBaseId(knowledgeBaseId)) {
      throw new KnowledgeError("IMA 资料库请在 IMA 平台中管理。", 400);
    }

    this.localProvider.deleteBase(knowledgeBaseId);
  }

  async listDocuments(knowledgeBaseId: string) {
    return isImaBaseId(knowledgeBaseId)
      ? this.imaProvider.listDocuments(knowledgeBaseId)
      : this.localProvider.listDocuments(knowledgeBaseId);
  }

  async listDocumentChunks(documentId: string) {
    return documentId.startsWith("ima:")
      ? this.imaProvider.listDocumentChunks(documentId)
      : this.localProvider.listDocumentChunks(documentId);
  }

  async addDocument(
    knowledgeBaseId: string,
    file: Express.Multer.File,
    metadata?: KnowledgeDocumentMetadata
  ) {
    if (isImaBaseId(knowledgeBaseId)) {
      throw new KnowledgeError("IMA 知识库暂不支持从本平台上传资料。", 400);
    }

    return this.localProvider.addDocument(knowledgeBaseId, file, metadata);
  }

  deleteDocument(knowledgeBaseId: string, documentId: string) {
    if (isImaBaseId(knowledgeBaseId)) {
      throw new KnowledgeError("IMA 知识库资料请在 IMA 平台中管理。", 400);
    }

    this.localProvider.deleteDocument(knowledgeBaseId, documentId);
  }

  async search({
    query,
    knowledgeBaseIds,
    topK = 6
  }: {
    query: string;
    knowledgeBaseIds: string[];
    topK?: number;
  }) {
    const localIds = knowledgeBaseIds.filter((id) => !isImaBaseId(id));
    const imaIds = knowledgeBaseIds.filter(isImaBaseId);
    const [localCitations, imaCitations] = await Promise.all([
      Promise.resolve(
        this.localProvider.search({
          query,
          knowledgeBaseIds: localIds,
          topK
        })
      ),
      this.imaProvider.search({
        query,
        knowledgeBaseIds: imaIds,
        topK
      })
    ]);

    return [...localCitations, ...imaCitations]
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }

  listProviderInfos(): KnowledgeProviderInfo[] {
    const localCount = this.localProvider.listBases().length;

    return [
      {
        id: "local",
        name: "本地知识库",
        status: "connected",
        description: "上传到本机 SQLite/FTS 的教学资料。",
        baseCount: localCount
      },
      this.imaProvider.getStatus()
    ];
  }

  testImaConnection() {
    return this.imaProvider.testConnection();
  }

  syncImaBases() {
    return this.imaProvider.syncBases();
  }
}

export class KnowledgeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "KnowledgeError";
  }
}

function validateKnowledgeFile(file: Express.Multer.File) {
  const extension = getFileExtension(file.originalname);

  if (!supportedDocumentExtensions.has(extension)) {
    throw new KnowledgeError(
      "只支持 PDF、Word（docx）、Excel（xlsx）、PPT（pptx）、TXT、MD、CSV、JSON；旧版 doc / xls / ppt 请先另存为新格式。",
      415
    );
  }

  if (file.size > maxKnowledgeDocumentBytes) {
    throw new KnowledgeError("知识库单个文件不能超过 10MB。", 413);
  }
}

async function extractKnowledgeText(file: Express.Multer.File) {
  const extension = getFileExtension(file.originalname);

  if (extension === "pdf") {
    const parser = new PDFParse({ data: file.buffer });

    try {
      const result = await parser.getText();
      const text = result.text.replace(/\u0000/g, "").trim();

      if (!text) {
        throw new KnowledgeError(
          "PDF 未提取到文字，可能是扫描件；本期暂不支持 OCR，请上传可复制文字的 PDF。",
          422
        );
      }

      assertTextIntegrity(text);
      return text;
    } finally {
      await parser.destroy();
    }
  }

  if (["docx", "xlsx", "pptx"].includes(extension)) {
    try {
      const ast = await OfficeParser.parseOffice(file.buffer, {
        fileType: extension as SupportedFileType,
        ocr: false
      });
      const text = ast.toText().replace(/\u0000/g, "").trim();

      if (!text) {
        throw new KnowledgeError("文件没有提取到可用于知识库的文字。", 422);
      }

      assertTextIntegrity(text);
      return text;
    } catch (error) {
      if (error instanceof KnowledgeError) {
        throw error;
      }

      throw new KnowledgeError("Office 文件解析失败，请确认文件未损坏或加密。", 422);
    }
  }

  if (["txt", "md", "csv", "json"].includes(extension)) {
    try {
      const text = decodeTextBuffer(file.buffer).text.trim();
      if (!text) {
        throw new KnowledgeError("文件没有提取到可用于知识库的文字。", 422);
      }

      return text;
    } catch (error) {
      if (error instanceof KnowledgeError) {
        throw error;
      }
      if (error instanceof TextEncodingError) {
        throw new KnowledgeError(error.message, 422);
      }
      throw error;
    }
  }

  throw new KnowledgeError("不支持的资料格式。", 415);
}

function assertTextIntegrity(text: string) {
  try {
    assertCleanText(text);
  } catch (error) {
    if (error instanceof TextEncodingError) {
      throw new KnowledgeError(error.message, 422);
    }
    throw error;
  }
}

function normalizeDocumentMetadata(
  metadata: KnowledgeDocumentMetadata
): Required<KnowledgeDocumentMetadata> {
  const resourceType = knowledgeResourceTypes.includes(metadata.resourceType || "其他")
    ? (metadata.resourceType || "其他")
    : "其他";
  const tags = Array.from(
    new Set(
      (metadata.tags || [])
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8)
    )
  );

  return {
    resourceType,
    subject: metadata.subject?.trim() || "",
    schoolStage: metadata.schoolStage?.trim() || "",
    tags
  };
}

function normalizeDocumentSummary(row: Record<string, unknown>): KnowledgeDocumentSummary {
  let tags: string[] = [];

  if (typeof row.tags === "string") {
    try {
      const parsed = JSON.parse(row.tags);
      tags = Array.isArray(parsed)
        ? parsed.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
        : [];
    } catch {
      tags = [];
    }
  }

  return {
    id: String(row.id),
    knowledgeBaseId: String(row.knowledgeBaseId),
    name: String(row.name),
    type: String(row.type),
    size: Number(row.size) || 0,
    chunkCount: Number(row.chunkCount) || 0,
    resourceType: knowledgeResourceTypes.includes(row.resourceType as KnowledgeResourceType)
      ? (row.resourceType as KnowledgeResourceType)
      : "其他",
    subject: typeof row.subject === "string" ? row.subject : "",
    schoolStage: typeof row.schoolStage === "string" ? row.schoolStage : "",
    tags,
    createdAt: String(row.createdAt)
  };
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && /unique constraint/i.test(error.message);
}

function splitTextIntoChunks(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];

  for (let index = 0; index < normalized.length; index += chunkSize - chunkOverlap) {
    const chunk = normalized.slice(index, index + chunkSize).trim();

    if (chunk.length > 30) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

function queryGrams(query: string) {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  const grams = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]{2,}/g) ?? []) {
    grams.add(word);
  }
  for (const segment of normalized.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    const chars = [...segment];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      grams.add(chars[index] + chars[index + 1]);
    }
    // 短词组保留整体，命中时相当于精确匹配加分。
    if (chars.length <= 4) grams.add(segment);
  }
  return [...grams].slice(0, 48);
}

function countOccurrences(text: string, gram: string) {
  let count = 0;
  let index = text.indexOf(gram);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(gram, index + gram.length);
  }
  return count;
}

function makeSnippet(query: string, content: string) {
  const grams = queryGrams(query).sort((left, right) => right.length - left.length);
  const lower = content.toLowerCase();
  const index = grams
    .map((gram) => lower.indexOf(gram))
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (index ?? 0) - 70);
  const snippet = content.slice(start, start + 180).trim();

  return snippet || content.slice(0, 180).trim();
}

function rowToCitation(row: ChunkRow, score: number): KnowledgeCitation {
  return {
    id: row.id,
    knowledgeBaseId: row.base_id,
    knowledgeBaseName: row.base_name,
    documentId: row.document_id,
    documentName: row.document_name,
    snippet: (row.snippet || row.content || "").replace(/\s+/g, " ").trim(),
    source: "local",
    score
  };
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function formatImaBaseId(externalId: string) {
  return `ima:${externalId}`;
}

function isImaBaseId(value: string) {
  return value.startsWith("ima:");
}

function getExternalImaBaseId(value: string) {
  return isImaBaseId(value) ? value.replace(/^ima:/, "") : "";
}

function readImaItems(payload: unknown) {
  const record = isRecord(payload) ? payload : {};
  const data = isRecord(record.data) ? record.data : record;
  const candidate =
    readFirstValue(data, [
      "info_list",
      "knowledge_bases",
      "knowledgeBases",
      "list",
      "items",
      "records",
      "results"
    ]) || [];

  return Array.isArray(candidate)
    ? candidate.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function readFirstString(value: unknown, keys: string[]) {
  const found = readFirstValue(value, keys);

  return typeof found === "string" && found.trim() ? found.trim() : "";
}

function readFirstValue(value: unknown, keys: string[]) {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) {
      return value[key];
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getFileExtension(fileName: string) {
  return path.extname(fileName).replace(".", "").toLowerCase();
}

