import type { Express, Response } from "express";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { CounselingServerEvent } from "../../shared/counseling.js";
import { isQwenConfigured } from "../qwenOpenAiClient.js";
import { getXfyunSpeechConfig, isXfyunSpeechConfigured, XfyunIatStream } from "../xfyunSpeechService.js";
import type { SQLiteChatRepository } from "../storage/chatRepository.js";
import { counselingCases } from "./cases.js";
import { CounselingError } from "./engine.js";
import { CounselingService } from "./service.js";
import { bindConnectionAuth } from "../auth/context.js";

function errorResponse(response: Response, error: unknown) {
  response.status(error instanceof CounselingError ? error.status : 500).json({ message: error instanceof Error ? error.message : "谈话请求失败。" });
}

export function registerCounseling(app: Express, server: Server, repository: SQLiteChatRepository) {
  const service = new CounselingService(repository);
  app.get("/api/counseling/config", (_request, response) => response.json({ cases: counselingCases, capabilities: { model: isQwenConfigured(), iflytek: isXfyunSpeechConfigured(), voice: "browser-or-iflytek" } }));
  app.post("/api/counseling/sessions", (request, response) => {
    try { response.status(201).json({ session: service.create(request.body) }); } catch (error) { errorResponse(response, error); }
  });
  app.get("/api/counseling/sessions/:id", (request, response) => {
    try { response.json({ session: service.view(request.params.id) }); } catch (error) { errorResponse(response, error); }
  });
  app.post("/api/counseling/sessions/:id/turn", async (request, response) => {
    try {
      if (typeof request.body?.text !== "string" || typeof request.body?.turnId !== "string") throw new CounselingError("发言内容或标识无效。");
      response.json({ session: await service.turn(request.params.id, request.body.text, request.body.turnId, "text") });
    } catch (error) { errorResponse(response, error); }
  });
  app.post("/api/counseling/sessions/:id/finish", async (request, response) => {
    try { response.json({ session: await service.finish(request.params.id) }); } catch (error) { errorResponse(response, error); }
  });
  app.post("/api/counseling/sessions/:id/save-draft", async (request, response) => {
    try { response.json({ session: await service.saveDraft(request.params.id) }); } catch (error) { errorResponse(response, error); }
  });
  app.get("/api/counseling/sessions/:id/report", (request, response) => {
    try { response.setHeader("Content-Disposition", 'attachment; filename="counseling-report.md"'); response.type("text/markdown").send(service.markdown(request.params.id)); } catch (error) { errorResponse(response, error); }
  });

  const realtime = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  realtime.on("connection", socket => {
    // upgrade 的鉴权只覆盖握手；消息回调要自己把身份带回来。
    const wrap = bindConnectionAuth();
    let id = "";
    let asr: XfyunIatStream | undefined;
    let audioQueue = Promise.resolve();
    let audioBacklog = 0;
    const emit = (event: CounselingServerEvent) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); };
    socket.on("message", async raw => {
      try {
        await wrap(async () => {
        const event = JSON.parse(String(raw)) as Record<string, unknown>;
        if (event.type === "start") {
          if (id) throw new CounselingError("此连接已绑定谈话。");
          const requested = String(event.sessionId || "");
          // 先让 view 校验归属，再绑定 id：校验失败的连接不该留下一个
          // 别人的会话号，否则 close 时的 cancel 会作用到那场谈话上。
          const session = service.view(requested);
          id = requested;
          emit({ type: "session", session });
          emit({ type: "ready" });
          return;
        }
        if (!id) throw new CounselingError("请先连接谈话会话。");
        if (event.type === "probe" && typeof event.text === "string" && typeof event.turnId === "string") service.probe(id, event.text, event.turnId, emit);
        else if (event.type === "turn" && typeof event.text === "string" && typeof event.turnId === "string") {
          try { await service.turn(id, event.text, event.turnId, "voice", emit); }
          finally { emit({ type: "turn_done", turnId: event.turnId }); }
        }
        else if (event.type === "cancel") service.cancel(id, typeof event.turnId === "string" ? event.turnId : undefined);
        else if (event.type === "delivery" && typeof event.messageId === "string" && ["playing", "played", "interrupted"].includes(String(event.delivery))) {
          service.delivery(id, event.messageId, event.delivery as "playing" | "played" | "interrupted", typeof event.playedMs === "number" ? event.playedMs : 0);
          emit({ type: "session", session: service.view(id) });
        }
        else if (event.type === "audio_frame" && typeof event.audio === "string") {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(event.audio) || event.audio.length > 16000) throw new CounselingError("音频帧无效。");
          if (++audioBacklog > 100) { audioBacklog--; throw new CounselingError("音频网络拥塞，请暂停后重试。"); }
          const audio = event.audio;
          audioQueue = audioQueue.then(async () => {
            if (!asr) {
              const config = getXfyunSpeechConfig();
              if (!config) throw new CounselingError("讯飞语音尚未配置，可切换浏览器语音。");
              asr = new XfyunIatStream(config, { onTranscript(text, final) { emit({ type: "asr", text, final }); if (final) asr = undefined; }, onError(message) { emit({ type: "error", message }); asr?.close(); asr = undefined; } });
            }
            await asr.sendAudioFrame(audio);
          }).catch(error => emit({ type: "error", message: error instanceof Error ? error.message : "语音识别失败。" })).finally(() => { audioBacklog--; });
        } else if (event.type === "audio_end") {
          await audioQueue;
          await asr?.finish();
          asr = undefined;
        }
        });
      } catch (error) { emit({ type: "error", message: error instanceof Error ? error.message : "实时连接处理失败。" }); }
    });
    socket.on("close", () => wrap(() => { if (id) service.cancel(id); asr?.close(); asr = undefined; }));
  });
  return { realtime, service };
}
