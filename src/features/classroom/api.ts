import type {
  ClassroomActionType,
  ClassroomArtifact,
  ClassroomCitation,
  ClassroomConfig,
  ClassroomReport,
  ClassroomSpeakResponse,
  ClassroomState
} from "./types";

export async function createClassroom(
  config: ClassroomConfig & { knowledgeBaseIds?: string[] }
) {
  const payload = await postJson<{
    sessionId: string;
    classroomState: ClassroomState;
  }>("/api/classroom/create", config);

  return payload;
}

export async function getClassroom(sessionId: string) {
  const response = await fetch(`/api/classroom/${encodeURIComponent(sessionId)}`);

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new Error(payload?.message || "虚拟课堂会话不存在。");
  }

  return response.json() as Promise<{
    sessionId: string;
    classroomState: ClassroomState;
  }>;
}

export async function restoreClassroom(classroomState: ClassroomState) {
  const payload = await postJson<{
    sessionId: string;
    classroomState: ClassroomState;
  }>("/api/classroom/restore", { classroomState });

  return payload;
}

export async function sendTeacherSpeech(sessionId: string, teacherText: string) {
  return postJson<ClassroomSpeakResponse>("/api/classroom/teacher-speak", {
    sessionId,
    teacherText
  });
}

export async function sendClassroomAction({
  sessionId,
  actionType,
  targetStudentId,
  teacherText
}: {
  sessionId: string;
  actionType: ClassroomActionType;
  targetStudentId?: string;
  teacherText?: string;
}) {
  return postJson<ClassroomSpeakResponse>("/api/classroom/action", {
    sessionId,
    actionType,
    targetStudentId,
    teacherText
  });
}

export async function requestClassroomReport(sessionId: string) {
  const payload = await postJson<{
    report: ClassroomReport;
    citations: ClassroomCitation[];
    saveError?: string;
    artifact?: ClassroomArtifact;
  }>("/api/classroom/report", { sessionId });

  return payload;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new Error(payload?.message || "虚拟课堂请求失败。");
  }

  return response.json() as Promise<T>;
}
