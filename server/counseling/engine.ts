import { randomUUID } from "node:crypto";
import type { CounselingConfig, CounselingSession, CounselingMove, CounselingEvent, CounselingReport, StudentState } from "../../shared/counseling.js";
import { counselingCases } from "./cases.js";

export type InternalSession = CounselingSession & { state: StudentState; evidence: NonNullable<CounselingSession["evidence"]> };
export class CounselingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const clamp = (value: number) => Math.max(0, Math.min(100, value));

const MODES = ["guided", "assessment"];
const RISKS = ["ordinary", "screening", "urgent"];
const EMOTIONS = ["焦虑", "低落", "愤怒", "委屈", "麻木"];

const MODE_ALIASES: Record<string, string> = {
  "引导": "guided", "指导": "guided", "训练": "guided", "陪伴": "guided",
  "评估": "assessment", "考核": "assessment", "测评": "assessment"
};
const RISK_ALIASES: Record<string, string> = {
  "普通": "ordinary", "一般": "ordinary", "常规": "ordinary",
  "筛查": "screening", "重点关注": "screening", "观察": "screening",
  "紧急": "urgent", "危机": "urgent", "高危": "urgent"
};
const EMOTION_ALIASES: Record<string, string> = {
  "生气": "愤怒", "恼火": "愤怒", "恼怒": "愤怒", "气愤": "愤怒",
  "难过": "低落", "伤心": "低落", "沮丧": "低落", "消沉": "低落", "闷闷不乐": "低落",
  "担心": "焦虑", "紧张": "焦虑", "不安": "焦虑", "压力大": "焦虑", "焦虑": "焦虑",
  "憋屈": "委屈", "不平": "委屈",
  "冷漠": "麻木", "呆滞": "麻木"
};

function asEnum(value: unknown, allowed: string[], aliases: Record<string, string>, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (allowed.includes(text)) return text;
  return aliases[text] ?? fallback;
}

function asNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * 对话里直接调用工作流时，模型给的配置经常是中文描述或缺字段。
 * 这里按关键词落到现有虚拟个案，再用个案默认值补齐，避免整条工作流因参数格式失败。
 */
export function inferCaseId(text: string): string {
  if (/自伤|自杀|伤害自己|不想活|消失就好|结束生命|活不下去/.test(text)) return "safety";
  if (/宿舍|室友|同寝|作息冲突/.test(text)) return "dormitory";
  if (/分手|失恋|恋爱|亲密关系|对象分开/.test(text)) return "relationship";
  if (/生活费|家庭经济|经济困难|兼职|欠费|资助/.test(text)) return "financial";
  if (/处分|顶撞|被记名字|课堂冲突|不公平/.test(text)) return "conflict";
  if (/成绩|考试|挂科|补考|学业|学习压力|学不进去/.test(text)) return "academic";
  return "academic";
}

export function normalizeConfig(input: unknown): CounselingConfig {
  // 模型偶发把整个 config 传成描述字符串，也按个案意图接住。
  const value: Record<string, unknown> =
    typeof input === "string" ? { note: input } :
    input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> :
    {};

  const hints = [
    "note", "description", "background", "scenario", "situation", "student",
    "text", "query", "summary", "context", "case", "学生情况", "情况", "描述", "背景"
  ].map((key) => value[key]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ");

  const rawCase = typeof value.caseId === "string" ? value.caseId.trim() : "";
  const student =
    counselingCases.find((item) => item.id === rawCase) ??
    counselingCases.find((item) => hints.includes(item.name) || hints.includes(item.title)) ??
    counselingCases.find((item) => rawCase && (rawCase.includes(item.name) || rawCase.includes(item.title))) ??
    counselingCases.find((item) => inferCaseId(hints) === item.id) ??
    counselingCases[0];

  return {
    caseId: student.id,
    mode: asEnum(value.mode, MODES, MODE_ALIASES, "guided"),
    emotion: asEnum(value.emotion, EMOTIONS, EMOTION_ALIASES, student.defaults.emotion),
    intensity: asNumber(value.intensity, 1, 5, student.defaults.intensity),
    trust: asNumber(value.trust, 0, 100, student.defaults.trust),
    openness: asNumber(value.openness, 0, 100, student.defaults.openness),
    // A scenario with explicit safety cues cannot be relabeled as an ordinary case.
    risk: student.id === "safety" ? "urgent" : asEnum(value.risk, RISKS, RISK_ALIASES, student.defaults.risk)
  } as CounselingConfig;
}

export function createSession(input: unknown): InternalSession {
  const config = normalizeConfig(input);
  const student = counselingCases.find(item => item.id === config.caseId)!;
  const now = Date.now();
  const session: InternalSession = {
    id: `counseling_${randomUUID()}`, config, student, status: "active", createdAt: now, updatedAt: now,
    state: { trust: config.trust, openness: config.openness, tension: config.intensity * 18 }, evidence: [], events: [],
    messages: [{ id: randomUUID(), turnId: "opening", role: "student", text: student.opening, at: now, source: "simulation", delivery: "text", generation: "scenario" }]
  };
  if (config.risk === "urgent") session.events.push({ id: randomUUID(), turnId: "opening", at: now, kind: "risk", severity: "critical", title: "安全演练：先确认即时安全", evidence: student.opening, suggestion: "平静直接地询问是否有伤害自己的想法、当下是否安全及是否独处；按校内流程联系专业人员。不能以聊天替代紧急支持。" });
  return session;
}

export function publicSession(session: InternalSession): CounselingSession {
  if (session.config.mode === "guided" || session.status === "finished") return structuredClone(session);
  const { state: _state, evidence: _evidence, ...visible } = session;
  return { ...structuredClone(visible), events: session.events.filter(event => event.kind === "interruption" || event.severity === "critical") };
}

export function analyzeMoves(text: string): CounselingMove[] {
  const moves: CounselingMove[] = [];
  const rules: Array<[CounselingMove, RegExp]> = [
    ["welcome", /谢谢你|愿意来|愿意找我|很高兴|坐下来|你可以慢慢说/],
    ["empathy", /听起来|听上去|你感到|你觉得.*(难|累|委屈|压力)|一定很|很不容易|我听到|你的感受/],
    ["open_question", /能.{0,8}(说说|讲讲|聊聊)|发生了什么|最.{0,8}(担心|难受|困扰)|你希望|怎么想|什么让你/],
    ["clarify", /是指|理解得对吗|具体|什么时候|持续多久|多久了/],
    ["safety", /(?:有没有|是否|会不会|有过|现在.{0,5}有|想过).{0,16}(伤害自己|自杀|轻生|结束生命)|现在.{0,8}(安全|一个人|独处)|身边.{0,8}(有人|谁)/],
    ["boundary", /保密.{0,16}(但是|但|例外|安全|生命)|涉及.{0,8}(安全|生命).{0,16}(联系|告知|求助)|必要.{0,6}(信息|人员)/],
    ["plan", /一起.{0,10}(联系|预约|制定|安排)|心理中心|资助中心|明天.{0,10}(联系|见|确认)|校内.{0,8}(流程|专业)|急救|120|110/],
    ["repair", /对不起|抱歉|刚才.{0,10}(急|不妥|没听|打断|误解)|我收回|重新听/],
    ["judgment", /你就是.{0,6}(懒|矫情|脆弱|不努力)|别矫情|想太多|有什么好难过|这有什么|别人都能|你怎么这么|都是你的错/],
    ["absolute_secret", /绝对保密|保证.{0,6}不告诉任何人|任何情况.{0,8}不会告诉/]
  ];
  for (const [move, pattern] of rules) if (pattern.test(text)) moves.push(move);
  // Quoted examples and explicit retractions must not be treated as a new accusation.
  if (/不该说|不能说|不应该说|收回|不是.{0,8}(矫情|懒|想太多)/.test(text)) return moves.filter(move => move !== "judgment" && move !== "absolute_secret");
  return moves;
}

export function makeCue(text: string, turnId: string): CounselingEvent | undefined {
  const moves = analyzeMoves(text);
  const secret = moves.includes("absolute_secret");
  if (!secret && !moves.includes("judgment")) return undefined;
  return { id: randomUUID(), at: Date.now(), turnId, kind: secret ? "risk" : "cue", severity: secret ? "critical" : "warning", title: secret ? "保密承诺缺少安全例外" : "留意否定与评判", evidence: text, suggestion: secret ? "说明隐私保护和涉及生命安全时的必要告知边界，不承诺无条件保密。" : "先确认学生的感受，再澄清发生的事情。可以说：听起来这件事让你很委屈。" };
}

export function applyTurn(session: InternalSession, text: string, turnId: string, source: "text" | "voice") {
  if (session.status !== "active") throw new CounselingError("本次谈话已经结束。", 409);
  if (!text.trim() || text.length > 2000) throw new CounselingError("每次发言需为 1 至 2000 个字符。");
  if (session.evidence.length >= 100) throw new CounselingError("本次训练已达 100 次发言，请结束复盘。");
  const at = Date.now();
  const moves = analyzeMoves(text);
  const before = { ...session.state };
  const negative = moves.includes("judgment") || moves.includes("absolute_secret");
  const positive = moves.some(move => ["empathy", "repair", "welcome"].includes(move));
  session.state = {
    trust: clamp(before.trust + (negative ? -12 : positive ? 6 : 0)),
    openness: clamp(before.openness + (negative ? -10 : positive || moves.includes("open_question") ? 5 : 0)),
    tension: clamp(before.tension + (negative ? 10 : positive ? -4 : 0))
  };
  session.messages.push({ id: randomUUID(), turnId, role: "counselor", text: text.trim(), at, source });
  session.evidence.push({ turnId, at, text, moves });
  const cue = makeCue(text, turnId);
  if (cue && !session.events.some(event => event.turnId === turnId && event.title === cue.title)) session.events.push(cue);
  session.events.push({ id: randomUUID(), at, turnId, kind: "state", severity: negative ? "warning" : "info", title: negative ? "虚拟学生转为防御" : positive ? "虚拟学生更愿意表达" : "学生状态保持", evidence: text, suggestion: negative ? "先回应感受，并修复刚才的表述。" : "继续核对理解，不急于提供结论。", before, after: { ...session.state } });
  session.updatedAt = at;
  return moves;
}

export function scenarioReply(session: InternalSession, moves: CounselingMove[]): string {
  if (moves.includes("absolute_secret")) return "真的无论发生什么都不会告诉别人吗？我也不知道这样对不对。";
  if (moves.includes("judgment")) return "老师，等一下。您这样说，我觉得自己的感受没有被听见。";
  if (moves.includes("safety")) return session.config.risk === "urgent" ? "这些念头最近反复出现，我有点害怕。我现在是一个人，希望有人能陪着我。" : "目前没有伤害自己的想法。我只是觉得很累，想有人认真听我说。";
  if (moves.includes("repair")) return "谢谢您愿意重新听。我刚才不是想反驳，只是怕又被误解了。";
  if (moves.includes("boundary")) return "我明白了。真有安全问题的时候，您会先和我说明，再找必要的人帮忙，对吗？";
  if (moves.includes("plan")) return session.state.trust >= 35 ? "可以先一起联系一下吗？我一个人不太敢去。之后什么时候再和您聊比较合适？" : "我还没准备好。能不能先听我把事情说完，再决定怎么办？";
  if (moves.includes("empathy") || moves.includes("open_question") || moves.includes("clarify")) return session.student.concern;
  if (moves.includes("welcome")) return "谢谢老师。我有点不知道从哪里开始说，您能先听我慢慢讲吗？";
  return session.state.openness < 35 ? "嗯……我还不太想展开说。能给我一点时间吗？" : `${session.student.concern} 您觉得我可以先从哪里开始？`;
}

export function buildReport(session: InternalSession): CounselingReport {
  if (!session.evidence.length) throw new CounselingError("至少完成一次辅导员发言后再复盘。");
  const evidenceFor = (moves: CounselingMove[]) => session.evidence.filter(item => moves.some(move => item.moves.includes(move)));
  const specs: Array<[string, CounselingMove[], number, boolean]> = [
    ["关系建立", ["welcome"], 15, true], ["倾听共情", ["empathy"], 20, true],
    ["提问澄清", ["open_question", "clarify"], 15, true],
    ["安全确认", ["safety"], 20, session.config.risk !== "ordinary"],
    ["边界与支持计划", ["boundary", "plan"], 20, true],
    ["谈话修复", ["repair"], 10, session.events.some(event => event.kind === "interruption" || event.severity === "warning")]
  ];
  const dimensions = specs.map(([name, moves, _weight, applicable]) => {
    const evidence = evidenceFor(moves);
    const coverage = moves.filter(move => evidence.some(item => item.moves.includes(move))).length;
    let score = coverage ? Math.round(50 + 35 * coverage / moves.length) : 0;
    if (name === "倾听共情" && evidenceFor(["judgment"]).length) score = Math.max(0, score - 25);
    if (name === "边界与支持计划" && evidenceFor(["absolute_secret"]).length) score = Math.max(0, score - 30);
    return { name, score, applicable, evidenceIds: evidence.map(item => item.turnId), comment: !applicable ? "本轮未出现对应考察情境，不计入总分。" : evidence.length ? `识别到 ${evidence.length} 处相关表达；属于规则辅助评价，需结合原文复核。` : "本轮尚未观察到明确行为证据。" };
  });
  const weight = specs.reduce((sum, spec) => sum + (spec[3] ? spec[2] : 0), 0);
  const overallScore = Math.round(dimensions.reduce((sum, dimension, index) => sum + (dimension.applicable ? dimension.score * specs[index][2] : 0), 0) / weight);
  const issues = dimensions.filter(item => item.applicable && item.score < 60).map(item => `${item.name}：${item.comment}`);
  const safetyStatus = session.config.risk === "ordinary" ? "not_triggered" : evidenceFor(["safety"]).length && evidenceFor(["plan"]).length ? "actions_observed" : "needs_review";
  return { overallScore, dimensions, strengths: dimensions.filter(item => item.applicable && item.score >= 75).map(item => `${item.name}已有表达证据。`), issues, nextTask: safetyStatus === "needs_review" ? "重练直接安全询问、联系现实支持与校内专业转介；由指导教师复核。" : `围绕${dimensions.find(item => item.applicable && item.score < 60)?.name || "倾听共情"}重练一次，先复述学生感受，再商定下一步行动。`, safetyStatus, interruptions: { counselor: session.events.filter(item => item.kind === "interruption" && item.by === "counselor").length, student: session.events.filter(item => item.kind === "interruption" && item.by === "student").length, repairs: evidenceFor(["repair"]).length }, generatedAt: Date.now() };
}
