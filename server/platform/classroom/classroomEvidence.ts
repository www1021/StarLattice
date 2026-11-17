/**
 * 课堂证据统计与量表一致性检验：两个确定性计算，均为纯函数、零模型依赖。
 *
 * 之所以用代码算而不用模型判：观察员 Agent 会写出「师生互动良好」这类结论，
 * 但需要的是教师话语占比多少、提问多少次、五位观察员在同一维度上的分差
 * 有多大、有没有踩到一票否决红线。这些数字模型既算不准也会随手编，
 * 只有确定性函数能当门禁依据。
 *
 * 刻意不做的事：不判断「课上得好不好」、不生成改进建议。那是 Agent 的活。
 */

export type Utterance = {
  /** 说话人身份，teacher / student / 具体学生名。 */
  speaker: string;
  /** 发言文本。 */
  text: string;
  /** 起始秒，可选；缺时间信息时时长类指标返回 0。 */
  startSec?: number;
  endSec?: number;
};

export type EvidenceResult = {
  turnCount: number;
  teacherTurns: number;
  studentTurns: number;
  teacherTokenRatio: number;
  questionCount: number;
  studentQuestionCount: number;
  avgTeacherTurnChars: number;
  avgStudentTurnChars: number;
  longestTeacherTurnSec: number;
  silenceGapsSec: number[];
  durationSec: number;
  /** 供观察员引用的证据片段，按话语轮次截取。 */
  excerpts: string[];
};

const QUESTION_MARKS = ["?", "？"];

function isTeacher(speaker: string): boolean {
  const value = speaker.trim();
  return value === "teacher" || value === "教师" || value === "老师" || value.includes("teacher");
}

function countQuestions(text: string): number {
  let count = 0;
  for (const mark of QUESTION_MARKS) {
    count += text.split(mark).length - 1;
  }
  return count;
}

export function computeClassroomEvidence(utterances: Utterance[]): EvidenceResult {
  const turns = utterances.filter((item) => item && typeof item.text === "string" && item.text.trim() !== "");
  const teacher = turns.filter((item) => isTeacher(item.speaker));
  const student = turns.filter((item) => !isTeacher(item.speaker));
  const teacherChars = teacher.reduce((sum, item) => sum + item.text.length, 0);
  const studentChars = student.reduce((sum, item) => sum + item.text.length, 0);
  const totalChars = teacherChars + studentChars;

  const timed = turns
    .filter((item) => typeof item.startSec === "number" && typeof item.endSec === "number")
    .map((item) => ({ start: item.startSec as number, end: item.endSec as number }))
    .sort((a, b) => a.start - b.start);
  const durationSec = timed.length > 0 ? Math.max(...timed.map((item) => item.end)) - Math.min(...timed.map((item) => item.start)) : 0;
  const longestTeacherTurnSec = teacher.reduce((max, item) => {
    if (typeof item.startSec !== "number" || typeof item.endSec !== "number") return max;
    return Math.max(max, item.endSec - item.startSec);
  }, 0);

  const silenceGapsSec: number[] = [];
  for (let i = 1; i < timed.length; i += 1) {
    const gap = timed[i].start - timed[i - 1].end;
    if (gap > 3) silenceGapsSec.push(Number(gap.toFixed(1)));
  }

  return {
    turnCount: turns.length,
    teacherTurns: teacher.length,
    studentTurns: student.length,
    teacherTokenRatio: totalChars === 0 ? 0 : Number((teacherChars / totalChars).toFixed(3)),
    questionCount: teacher.reduce((sum, item) => sum + countQuestions(item.text), 0),
    studentQuestionCount: student.reduce((sum, item) => sum + countQuestions(item.text), 0),
    avgTeacherTurnChars: teacher.length === 0 ? 0 : Number((teacherChars / teacher.length).toFixed(1)),
    avgStudentTurnChars: student.length === 0 ? 0 : Number((studentChars / student.length).toFixed(1)),
    longestTeacherTurnSec: Number(longestTeacherTurnSec.toFixed(1)),
    silenceGapsSec,
    durationSec: Number(durationSec.toFixed(1)),
    excerpts: turns.slice(0, 20).map((item, index) => `${index + 1}. ${item.speaker}：${item.text.slice(0, 80)}`)
  };
}

export type ScoreEntry = {
  dimension: string;
  /** 各观察员在该维度上的分数，统一按 0-100 计。 */
  scores: number[];
};

export type RubricCheckInput = {
  dimensions: ScoreEntry[];
  /** 红线标记：命中任意一条即一票否决，不再看分数。 */
  redlines?: Array<{ code: string; hit: boolean; evidence?: string }>;
  /** 同一维度上观察员分数的最大允许极差，默认 25 分。 */
  maxSpread?: number;
  /** 平均分达标线，默认 70 分。 */
  passScore?: number;
};

export type RubricCheckResult = {
  passed: boolean;
  redlineHit: boolean;
  redlines: Array<{ code: string; hit: boolean; evidence?: string }>;
  consensusScore: number;
  maxSpread: number;
  passScore: number;
  dimensions: Array<{
    dimension: string;
    mean: number;
    spread: number;
    stdev: number;
    divergent: boolean;
  }>;
  divergentDimensions: string[];
  verdict: "redline" | "divergent" | "pass" | "below";
  note: string;
};

const round3 = (value: number) => Number(value.toFixed(3));

export function checkRubric(input: RubricCheckInput): RubricCheckResult {
  const maxSpread = typeof input.maxSpread === "number" && input.maxSpread > 0 ? input.maxSpread : 25;
  const passScore = typeof input.passScore === "number" ? input.passScore : 70;
  const redlines = (input.redlines ?? []).map((item) => ({
    code: item.code,
    hit: Boolean(item.hit),
    evidence: item.evidence
  }));
  const redlineHit = redlines.some((item) => item.hit);

  const dimensions = input.dimensions
    .filter((item) => item && typeof item.dimension === "string" && item.scores.length > 0)
    .map((item) => {
      const scores = item.scores.filter((value) => Number.isFinite(value));
      const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
      const spread = Math.max(...scores) - Math.min(...scores);
      const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
      return {
        dimension: item.dimension,
        mean: round3(mean),
        spread: round3(spread),
        stdev: round3(Math.sqrt(variance)),
        divergent: spread > maxSpread
      };
    });

  const divergentDimensions = dimensions.filter((item) => item.divergent).map((item) => item.dimension);
  const consensusScore = dimensions.length === 0
    ? 0
    : round3(dimensions.reduce((sum, item) => sum + item.mean, 0) / dimensions.length);

  const verdict: RubricCheckResult["verdict"] = redlineHit
    ? "redline"
    : divergentDimensions.length > 0
      ? "divergent"
      : consensusScore < passScore
        ? "below"
        : "pass";
  const note = {
    redline: `命中 ${redlines.filter((item) => item.hit).map((item) => item.code).join("、")} 红线，一票否决，不再看分数。`,
    divergent: `维度 ${divergentDimensions.join("、")} 的观察员分差超过 ${maxSpread} 分，需仲裁重评。`,
    below: `各维共识分 ${consensusScore} 低于达标线 ${passScore}，需改进。`,
    pass: `各维共识分 ${consensusScore}，观察员分歧在允许范围内。`
  }[verdict];

  return {
    passed: verdict === "pass",
    redlineHit,
    redlines,
    consensusScore,
    maxSpread,
    passScore,
    dimensions,
    divergentDimensions,
    verdict,
    note
  };
}
