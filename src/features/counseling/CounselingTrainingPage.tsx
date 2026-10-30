import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { MicVAD } from "@ricky0123/vad-web";
import { AlertTriangle, ArrowLeft, AudioLines, Bot, CheckCircle2, ChevronRight, CircleStop, Headphones, LoaderCircle, MessageCircleHeart, Mic, Radio, Send, ShieldAlert, Sparkles, Square, UserRound, Volume2, VolumeX } from "lucide-react";
import type { CounselingCase, CounselingConfig, CounselingEvent, CounselingMessage, CounselingServerEvent, CounselingSession, StudentState } from "../../../shared/counseling";
import { createCounselingSession, finishCounselingSession, getCounselingSession, loadCounselingConfig, saveCounselingDraft, submitCounselingTurn } from "./api";

const statusText = (session?: CounselingSession) => {
  if (!session) return "选择一个虚拟个案，开始谈话训练。";
  if (session.status === "finished") return "本次谈话已结束，复盘报告已保存。";
  return "学生可随时插话；你也可以在学生语音播放时开口打断。";
};
const idOf = () => `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const stateLabel: Array<[keyof StudentState, string]> = [["trust", "信任"], ["openness", "开放"], ["tension", "紧张"]];
const waveBars = Array.from({ length: 15 }, (_, index) => index);

type CounselingTrainingPageProps = { onTrainingSaved?: () => void; initialSessionId?: string };
export function CounselingTrainingPage({ onTrainingSaved, initialSessionId }: CounselingTrainingPageProps) {
  const [cases, setCases] = useState<CounselingCase[]>([]);
  const [capabilities, setCapabilities] = useState<{ model: boolean; iflytek: boolean }>({ model: false, iflytek: false });
  const [config, setConfig] = useState<CounselingConfig>();
  const [session, setSession] = useState<CounselingSession>();
  const [status, setStatus] = useState("正在读取虚拟个案...");
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isCounselorSpeaking, setIsCounselorSpeaking] = useState(false);
  const [isStudentSpeaking, setIsStudentSpeaking] = useState(false);
  const [counselorVoiceLevel, setCounselorVoiceLevel] = useState(0);
  const [voiceAutoSend, setVoiceAutoSend] = useState(false);
  const [isExitChoiceOpen, setIsExitChoiceOpen] = useState(false);
  const [interim, setInterim] = useState("");
  const [voiceSupported] = useState(() => Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const recognitionRef = useRef<SpeechRecognition | undefined>(undefined);
  const vadRef = useRef<MicVAD | undefined>(undefined);
  const shouldKeepListeningRef = useRef(false);
  const playingRef = useRef<{ messageId: string; startedAt: number } | undefined>(undefined);
  const spokenRef = useRef(new Set<string>());
  const sessionRef = useRef<CounselingSession | undefined>(undefined);
  const eventsRef = useRef<HTMLDivElement | null>(null);
  const finalDraftRef = useRef("");
  const voiceSubmitTimerRef = useRef<number | undefined>(undefined);
  const isWorkingRef = useRef(false);
  const activeTurnIdRef = useRef<string | undefined>(undefined);
  const voiceLevelRef = useRef({ value: 0, updatedAt: 0 });
  const voiceAutoSendRef = useRef(false);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    if (initialSessionId) {
      void getCounselingSession(initialSessionId).then((payload) => {
        setSession(payload.session);
        setConfig(payload.session.config);
        if (payload.session.status === "active") {
          connect(payload.session);
        }
        setStatus(statusText(payload.session));
      }).catch((err) => setError(err instanceof Error ? err.message : "谈话记录加载失败。"));
    }
    void loadCounselingConfig().then(payload => {
      setCases(payload.cases);
      setCapabilities(payload.capabilities);
      const initial = payload.cases[0];
      if (initial) setConfig({ caseId: initial.id, mode: "guided", ...initial.defaults });
      setStatus("请选择虚拟个案，设置状态后开始训练。");
    }).catch(err => { setError(err instanceof Error ? err.message : "虚拟个案加载失败。"); setStatus("虚拟个案加载失败。"); });
    return () => { shouldKeepListeningRef.current = false; recognitionRef.current?.abort(); void vadRef.current?.destroy(); if (voiceSubmitTimerRef.current) window.clearTimeout(voiceSubmitTimerRef.current); disconnect(); setIsCounselorSpeaking(false); setIsStudentSpeaking(false); setCounselorVoiceLevel(0); window.speechSynthesis?.cancel(); };
  }, [initialSessionId]);
  useEffect(() => { isWorkingRef.current = isWorking; }, [isWorking]);
  useEffect(() => { voiceAutoSendRef.current = voiceAutoSend; }, [voiceAutoSend]);
  useEffect(() => { if (session?.events.length) eventsRef.current?.scrollTo({ top: eventsRef.current.scrollHeight, behavior: "smooth" }); }, [session?.events.length]);

  function socketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/api/counseling/realtime`;
  }
  function sendRealtime(event: Record<string, unknown>) { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(event)); }
  function disconnect() { socketRef.current?.close(); socketRef.current = undefined; }
  function connect(next: CounselingSession) {
    disconnect();
    const socket = new WebSocket(socketUrl()); socketRef.current = socket;
    socket.onopen = () => { socket.send(JSON.stringify({ type: "start", sessionId: next.id })); setStatus("实时谈话通道已连接，可开始语音或文字谈话。"); };
    socket.onmessage = event => handleRealtimeEvent(JSON.parse(event.data) as CounselingServerEvent);
    socket.onerror = () => setStatus("实时语音通道连接失败，仍可用文字谈话。");
    socket.onclose = () => { if (socketRef.current === socket) socketRef.current = undefined; };
  }
  function handleRealtimeEvent(event: CounselingServerEvent) {
    if (event.type === "session") { setSession(event.session); const latest = event.session.messages[event.session.messages.length - 1]; if (latest?.role === "student" && !spokenRef.current.has(latest.id)) speakStudent(latest); return; }
    if (event.type === "student_interrupt") { setStatus("学生打断了谈话，请先回应其感受。"); window.speechSynthesis?.cancel(); setSession(current => current ? { ...current, messages: [...current.messages, { id: `interrupt_${event.turnId}`, turnId: `${event.turnId}:interrupt`, role: "student", text: event.text, at: Date.now(), source: "simulation", delivery: "text", generation: "scenario" }], events: event.event ? [...current.events, event.event] : current.events } : current); return; }
    if (event.type === "asr") { setInterim(current => current + event.text); if (event.final && event.text.trim()) { setDraft(current => `${current}${current ? "" : ""}${event.text}`); setInterim(""); } return; }
    if (event.type === "cancelled") { setStatus("学生回复已被新的发言打断，正在保留当前谈话上下文。"); return; }
    if (event.type === "turn_done") {
      if (activeTurnIdRef.current === event.turnId) {
        activeTurnIdRef.current = undefined;
        setIsWorking(false);
        setStatus("学生已回应，可继续澄清感受、事实与下一步支持。");
      }
      return;
    }
    if (event.type === "error") {
      activeTurnIdRef.current = undefined;
      setIsWorking(false);
      setError(event.message);
      setStatus(event.message);
    }
  }
  async function begin() {
    if (!config) return;
    setIsWorking(true); setError(undefined);
    try { const payload = await createCounselingSession(config); setSession(payload.session); connect(payload.session); setStatus("虚拟个案已就绪。先建立关系，再慢慢了解发生了什么。"); } catch (err) { setError(err instanceof Error ? err.message : "创建谈话失败。"); } finally { setIsWorking(false); }
  }
  async function submit(text = draft, source: "text" | "voice" = "text") {
    if (!session || !text.trim() || isWorking || session.status !== "active") return;
    const turnId = idOf(); setIsWorking(true); activeTurnIdRef.current = turnId; setError(undefined); setDraft(""); setInterim("");
    // The local microphone must take priority over TTS; the server also aborts an unfinished reply.
    if (playingRef.current) { sendRealtime({ type: "delivery", messageId: playingRef.current.messageId, delivery: "interrupted", playedMs: Date.now() - playingRef.current.startedAt }); window.speechSynthesis?.cancel(); playingRef.current = undefined; }
    const usesRealtime = socketRef.current?.readyState === WebSocket.OPEN;
    try {
      if (usesRealtime) { sendRealtime({ type: "cancel" }); sendRealtime({ type: "turn", turnId, text: text.trim() }); }
      else { const payload = await submitCounselingTurn(session.id, text.trim(), turnId); setSession(payload.session); const latest = payload.session.messages[payload.session.messages.length - 1]; if (latest?.role === "student") speakStudent(latest); }
      setStatus("正在分析谈话行为并组织学生回应...");
    } catch (err) {
      activeTurnIdRef.current = undefined;
      setError(err instanceof Error ? err.message : "发言提交失败。");
      setDraft(text);
      setIsWorking(false);
    } finally {
      if (!usesRealtime) {
        activeTurnIdRef.current = undefined;
        setIsWorking(false);
      }
    }
  }
  function speakStudent(message: CounselingMessage) {
    if (!("speechSynthesis" in window) || !message.text.trim() || message.delivery === "interrupted") return;
    spokenRef.current.add(message.id); window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message.text); utterance.lang = "zh-CN"; utterance.rate = 1.02; utterance.pitch = 1;
    utterance.onstart = () => { playingRef.current = { messageId: message.id, startedAt: Date.now() }; setIsStudentSpeaking(true); sendRealtime({ type: "delivery", messageId: message.id, delivery: "playing" }); };
    utterance.onend = () => { if (playingRef.current?.messageId === message.id) { sendRealtime({ type: "delivery", messageId: message.id, delivery: "played", playedMs: Date.now() - playingRef.current.startedAt }); playingRef.current = undefined; } setIsStudentSpeaking(false); };
    utterance.onerror = () => { playingRef.current = undefined; setIsStudentSpeaking(false); };
    window.speechSynthesis.speak(utterance);
  }
  async function interruptStudentByVoice() {
    if (!playingRef.current) return;
    sendRealtime({ type: "delivery", messageId: playingRef.current.messageId, delivery: "interrupted", playedMs: Date.now() - playingRef.current.startedAt });
    window.speechSynthesis.cancel();
    playingRef.current = undefined;
    setIsStudentSpeaking(false);
  }
  async function startListening() {
    if (!session || !voiceSupported || session.status !== "active") return;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!Recognition) return;
    setIsListening(true);
    setStatus("正在开启实时语音，允许麦克风后即可开始双向交流。");
    try {
      const { MicVAD: VoiceActivityDetector } = await import("@ricky0123/vad-web");
      vadRef.current = await VoiceActivityDetector.new({
        model: "v5",
        baseAssetPath: "/voice-assets/",
        onnxWASMBasePath: "/voice-assets/",
        startOnLoad: false,
        minSpeechMs: 180,
        redemptionMs: 650,
        onSpeechStart: () => { setIsCounselorSpeaking(true); void interruptStudentByVoice(); },
        onSpeechEnd: () => { setIsCounselorSpeaking(false); setCounselorVoiceLevel(0); },
        onFrameProcessed: (probabilities, frame) => {
          let energy = 0;
          for (let index = 0; index < frame.length; index += 1) energy += frame[index] * frame[index];
          const rms = Math.sqrt(energy / Math.max(frame.length, 1));
          const level = Math.min(1, Math.max(probabilities.isSpeech, rms * 7));
          const now = performance.now();
          if (now - voiceLevelRef.current.updatedAt > 60 || Math.abs(level - voiceLevelRef.current.value) > 0.12) {
            voiceLevelRef.current = { value: level, updatedAt: now };
            setCounselorVoiceLevel(level);
          }
        }
      });
      await vadRef.current.start();
    } catch {
      setStatus("语音活动检测未启动，将在识别结果到达时中断学生语音。");
    }
    recognitionRef.current?.abort(); const recognition = new Recognition(); recognition.lang = "zh-CN"; recognition.continuous = true; recognition.interimResults = true; shouldKeepListeningRef.current = true;
    recognition.onresult = result => { let finalText = ""; let partial = ""; for (let index = result.resultIndex; index < result.results.length; index += 1) { const item = result.results[index][0]?.transcript || ""; if (result.results[index].isFinal) finalText += item; else partial += item; } setInterim(partial); if (partial) { setIsCounselorSpeaking(true); void interruptStudentByVoice(); sendRealtime({ type: "probe", turnId: "live_probe", text: partial }); } if (finalText) { finalDraftRef.current += finalText; setDraft(current => current + finalText); sendRealtime({ type: "probe", turnId: "live_probe", text: finalText }); if (voiceSubmitTimerRef.current) window.clearTimeout(voiceSubmitTimerRef.current); voiceSubmitTimerRef.current = window.setTimeout(() => { setIsCounselorSpeaking(false); setCounselorVoiceLevel(0); const textToSend = finalDraftRef.current.trim(); if (voiceAutoSendRef.current && textToSend && !isWorkingRef.current) { finalDraftRef.current = ""; void submit(textToSend, "voice"); } }, 900); } };
    recognition.onerror = event => { if (event.error !== "aborted" && event.error !== "no-speech") { shouldKeepListeningRef.current = false; setIsListening(false); setError(`语音识别：${event.error}`); } };
    recognition.onend = () => { if (shouldKeepListeningRef.current) { try { recognition.start(); } catch { /* Recognition restarts can race in Chromium. */ } } else setIsListening(false); };
    try {
      recognition.start();
      recognitionRef.current = recognition;
      setStatus("正在聆听。学生语音会在你开口时停止播放。");
    } catch (error) {
      shouldKeepListeningRef.current = false;
      setIsListening(false);
      setError(error instanceof Error ? `无法开启语音识别：${error.message}` : "无法开启语音识别。");
    }
  }
  function stopListening() { shouldKeepListeningRef.current = false; recognitionRef.current?.stop(); recognitionRef.current = undefined; void vadRef.current?.destroy(); vadRef.current = undefined; if (voiceSubmitTimerRef.current) window.clearTimeout(voiceSubmitTimerRef.current); finalDraftRef.current = ""; setIsCounselorSpeaking(false); setCounselorVoiceLevel(0); setIsListening(false); setInterim(""); }
  function completeExit() {
    stopListening();
    window.speechSynthesis?.cancel();
    setIsStudentSpeaking(false);
    disconnect();
    activeTurnIdRef.current = undefined;
    setSession(undefined);
    setDraft("");
    setError(undefined);
    setIsWorking(false);
    setIsExitChoiceOpen(false);
    setStatus("请选择下一位虚拟学生，开始新的谈话训练。");
  }
  function exitCase() {
    if (session?.status === "active" && session.messages.length > 1) {
      setIsExitChoiceOpen(true);
      return;
    }
    completeExit();
  }
  async function saveDraftAndExit() {
    if (!session || isWorking) return;
    setIsWorking(true);
    try {
      await saveCounselingDraft(session.id);
      onTrainingSaved?.();
      completeExit();
    } catch (error) {
      setError(error instanceof Error ? error.message : "未完成谈话保存失败。");
    } finally {
      setIsWorking(false);
    }
  }
  async function finish() {
    if (!session || isWorking) return; stopListening(); window.speechSynthesis?.cancel(); setIsWorking(true);
    try { const payload = await finishCounselingSession(session.id); setSession(payload.session); disconnect(); setStatus("复盘已生成并保存到历史记录与成长档案。"); onTrainingSaved?.(); } catch (err) { setError(err instanceof Error ? err.message : "生成复盘失败。"); } finally { setIsWorking(false); }
  }
  const selected = cases.find(item => item.id === config?.caseId);
  const state = session?.state;
  const latestCounselorText = interim || draft || [...(session?.messages || [])].reverse().find((message) => message.role === "counselor")?.text;
  const latestStudentText = [...(session?.messages || [])].reverse().find((message) => message.role === "student")?.text;
  const recentVoiceMessages = (session?.messages || []).slice(-3);
  return <section className="counseling-room" aria-label="辅导员谈心谈话实训">
    <header className="counseling-header">
      <div><span>Student Affairs Practice</span><h1>谈心谈话实训</h1><p>在虚拟个案中练习倾听、共情、安全确认、支持计划与被打断后的修复。</p></div>
      <div className="counseling-header-actions"><span className={`counseling-live ${session?.status === "active" ? "is-live" : ""}`}><Radio size={15} /> {session?.status === "active" ? "实时通话中" : "准备训练"}</span>{session ? <button type="button" className="counseling-exit" onClick={exitCase}><ArrowLeft size={16} />退出个案</button> : null}{session ? <button type="button" className="counseling-end" disabled={isWorking || session.status === "finished"} onClick={() => void finish()}><Square size={16} />结束并复盘</button> : null}</div>
    </header>
    {!session ? <section className="counseling-setup">
      <div className="counseling-case-picker"><div className="counseling-section-heading"><MessageCircleHeart size={20}/><div><h2>选择虚拟个案</h2><p>状态仅用于训练情境，不是对真实学生的心理诊断。</p></div></div><div className="counseling-case-list">{cases.map(item => <button type="button" key={item.id} className={config?.caseId === item.id ? "is-selected" : ""} onClick={() => setConfig(current => current ? { ...current, caseId: item.id, ...item.defaults, risk: item.defaults.risk } : undefined)}><strong>{item.title}</strong><span>{item.year} · {item.name}</span><small>{item.background}</small></button>)}</div></div>
      <aside className="counseling-config"><div className="counseling-section-heading"><Sparkles size={20}/><div><h2>设定谈话状态</h2><p>先设置当下可观察的情绪与互动倾向。</p></div></div>{config && selected ? <><label>训练方式<select value={config.mode} onChange={event => setConfig({ ...config, mode: event.target.value as CounselingConfig["mode"] })}><option value="guided">引导练习</option><option value="assessment">实战测评</option></select></label><label>当前情绪<select value={config.emotion} onChange={event => setConfig({ ...config, emotion: event.target.value as CounselingConfig["emotion"] })}>{["焦虑", "低落", "愤怒", "委屈", "麻木"].map(item => <option key={item}>{item}</option>)}</select></label>{[["intensity", "情绪强度", 1, 5], ["trust", "初始信任", 0, 100], ["openness", "表达意愿", 0, 100]].map(([key, label, min, max]) => <label key={key as string}>{label}<span>{config[key as keyof CounselingConfig] as number}</span><input type="range" min={min as number} max={max as number} value={config[key as keyof CounselingConfig] as number} onChange={event => setConfig({ ...config, [key]: Number(event.target.value) })} /></label>)}<div className={`counseling-risk risk-${config.risk}`}><ShieldAlert size={18}/><p><strong>{config.risk === "urgent" ? "安全演练个案" : config.risk === "screening" ? "需要进一步了解" : "普通关注个案"}</strong>{config.risk === "urgent" ? "系统将提示直接安全确认与现实支持联结；仅供演练。" : "系统会根据谈话内容提示关系、边界与节奏风险。"}</p></div><button type="button" className="counseling-start" disabled={isWorking} onClick={() => void begin()}>{isWorking ? <LoaderCircle className="is-spinning" size={17}/> : <ChevronRight size={18}/>}开始谈话训练</button></> : null}</aside>
    </section> : <section className="counseling-stage">
      <aside className="counseling-student"><div className="student-avatar"><UserRound size={34}/></div><span>虚拟学生</span><h2>{session.student.name}</h2><p>{session.student.year}</p><dl><div><dt>当前情境</dt><dd>{session.student.background}</dd></div><div><dt>谈话目标</dt><dd>{session.student.goal}</dd></div></dl>{state ? <div className="counseling-state"><header><span>互动状态</span>{session.config.mode === "assessment" && session.status === "active" ? <small>测评中隐藏</small> : null}</header>{session.config.mode === "assessment" && session.status === "active" ? <p>结束后展示状态变化和行为证据。</p> : stateLabel.map(([key, label]) => <div key={key}><span>{label}</span><i><b style={{ width: `${state[key]}%` }}/></i><strong>{state[key]}</strong></div>)}</div> : null}<div className="counseling-model-status"><Bot size={16}/><span>{capabilities.model ? "学生回应：模型增强与情境回退" : "学生回应：稳定情境回退"}</span></div></aside>
      <main className="counseling-conversation"><div className="counseling-conversation-head"><div><span>{isListening ? "实时语音对话" : "双轨谈话记录"}</span><small>{statusText(session)}</small></div><span>{session.messages.length} 条记录</span></div>{isListening ? <VoiceConversationStage counselorText={latestCounselorText} studentName={session.student.name} studentText={latestStudentText} counselorSpeaking={isCounselorSpeaking} counselorLevel={counselorVoiceLevel} studentSpeaking={isStudentSpeaking} recentMessages={recentVoiceMessages} autoSend={voiceAutoSend} onAutoSendChange={setVoiceAutoSend} onConfirm={() => { const text = draft.trim(); if (text) { finalDraftRef.current = ""; void submit(text, "voice"); } }} onStop={() => { stopListening(); window.speechSynthesis?.cancel(); setIsStudentSpeaking(false); }} /> : <div className="counseling-transcript" aria-live="polite">{session.messages.map(message => <article key={message.id} className={`counseling-message ${message.role}${message.delivery === "interrupted" ? " is-interrupted" : ""}`}><span>{message.role === "counselor" ? "辅导员" : session.student.name}{message.delivery === "interrupted" ? " · 已被打断" : ""}</span><p>{message.text}</p>{message.role === "student" ? <button type="button" title="播放学生语音" aria-label="播放学生语音" onClick={() => speakStudent(message)} disabled={message.delivery === "interrupted"}><Volume2 size={15}/></button> : null}</article>)}</div>}
        {session.status === "active" && !isListening ? <div className="counseling-composer"><div className="counseling-voice-status"><AudioLines size={16}/><span>{voiceSupported ? "浏览器语音可用；学生播放中开口会触发打断。" : "当前浏览器不支持语音识别，仍可文字谈话。"}</span></div><textarea value={draft + interim} aria-label="辅导员发言" placeholder="先从学生感受与事实开始，例如：听起来这段时间你一直很紧绷，愿意和我说说是什么让你最担心吗？" onChange={event => { setDraft(event.target.value); setInterim(""); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} /><div><button type="button" onClick={startListening} disabled={!voiceSupported || isWorking}><Mic size={17}/>语音谈话</button><button className="counseling-send" type="button" disabled={!draft.trim() || isWorking} onClick={() => void submit()}>{isWorking ? <LoaderCircle className="is-spinning" size={17}/> : <Send size={17}/>}发送</button></div></div> : null}
      </main>
      <aside className="counseling-coach"><div className="counseling-section-heading"><Headphones size={20}/><div><h2>实时教练</h2><p>{session.config.mode === "assessment" && session.status === "active" ? "测评模式只呈现必要安全提醒。" : "只在关系或安全节点提示。"}</p></div></div>{error ? <div className="counseling-alert is-error"><AlertTriangle size={17}/><p>{error}</p></div> : null}<div className="counseling-event-list" ref={eventsRef}>{visibleEvents(session).length ? visibleEvents(session).map(event => <CoachEvent key={event.id} event={event}/>) : <p className="counseling-empty">保持好奇和耐心，系统会在关键节点留下可复盘的提示。</p>}</div>{session.report ? <Report report={session.report} session={session} /> : null}<div className="counseling-status"><CheckCircle2 size={16}/><span>{status}</span></div></aside>
    </section>}
    {isExitChoiceOpen ? <div className="counseling-exit-choice" role="status"><div><strong>保存未完成谈话？</strong><p>保存后可从历史记录继续查看当前进度；不保存则仅退出当前个案。</p></div><div><button type="button" onClick={() => void saveDraftAndExit()} disabled={isWorking}>保存并退出</button><button type="button" onClick={completeExit} disabled={isWorking}>不保存退出</button><button type="button" onClick={() => setIsExitChoiceOpen(false)} disabled={isWorking}>继续谈话</button></div></div> : null}
  </section>;
}

function visibleEvents(session: CounselingSession) { return session.config.mode === "assessment" && session.status === "active" ? session.events.filter(event => event.severity === "critical" || event.kind === "interruption") : session.events; }
function VoiceConversationStage({ counselorText, studentName, studentText, counselorSpeaking, counselorLevel, studentSpeaking, recentMessages, autoSend, onAutoSendChange, onConfirm, onStop }: { counselorText?: string; studentName: string; studentText?: string; counselorSpeaking: boolean; counselorLevel: number; studentSpeaking: boolean; recentMessages: CounselingMessage[]; autoSend: boolean; onAutoSendChange: (value: boolean) => void; onConfirm: () => void; onStop: () => void; }) {
  return <section className="counseling-voice-stage" aria-label="实时语音对话舞台">
    <div className={`voice-audio-channel counselor ${counselorSpeaking ? "is-active" : ""}`}>
      <div className="voice-audio-role"><span>辅导员</span><small>{counselorSpeaking ? "正在表达" : "保持聆听"}</small></div>
      <div className="voice-audio-wave" aria-hidden="true">{waveBars.map((index) => <i key={index} style={{ animationDelay: `${index * 57}ms`, "--voice-level": `${0.18 + counselorLevel * (0.34 + ((index % 5) * 0.09))}` } as CSSProperties} />)}</div>
    </div>
    <div className="voice-stage-core">
      <div className="voice-live-bubbles" aria-live="polite">
        {studentText ? <article className={`voice-live-bubble student ${studentSpeaking ? "is-active" : ""}`}><span>{studentName} · 实时对话</span><p>{studentText}</p></article> : null}
        <article className={`voice-live-bubble counselor ${counselorSpeaking ? "is-active" : ""}`}><span>辅导员 · 实时转写</span><p>{counselorText || "正在聆听你的声音…"}</p></article>
      </div>
      <button className={`voice-stage-mic${counselorSpeaking || studentSpeaking ? " is-speaking" : ""}`} style={{ "--orb-motion": `${counselorSpeaking ? 1 + Math.min(1, Math.max(0, counselorLevel)) * 2 : 1.6}px` } as CSSProperties} type="button" onClick={onStop} aria-label="停止实时语音谈话" title="停止实时语音谈话"><span className="voice-stage-orb" aria-hidden="true" /></button>
      <span className="voice-stage-mic-label">结束聆听</span>
      <p className="voice-stage-title"><strong>实时聆听</strong><span>·</span>全双工对话</p>
      <small>{counselorSpeaking ? "正在理解辅导员表达" : studentSpeaking ? `${studentName}正在回应` : "等待下一段表达"}</small>
      <div className="voice-stage-send-control"><label><input type="checkbox" checked={autoSend} onChange={(event) => onAutoSendChange(event.target.checked)} />自动发送</label><button type="button" onClick={onConfirm} disabled={!counselorText?.trim()}>确认发送</button></div>
      <details className="voice-stage-context"><summary>最近记录（{recentMessages.length}）<ChevronRight size={15} /></summary><div>{recentMessages.map((message) => <p key={message.id}><strong>{message.role === "counselor" ? "辅导员" : studentName}</strong>{message.text}</p>)}</div></details>
    </div>
    <div className={`voice-audio-channel student ${studentSpeaking ? "is-active" : ""}`}>
      <div className="voice-audio-role"><span>{studentName}</span><small>{studentSpeaking ? "正在回应" : "保持聆听"}</small></div>
      <div className="voice-audio-wave" aria-hidden="true">{waveBars.map((index) => <i key={index} style={{ animationDelay: `${(waveBars.length - index) * 57}ms` }} />)}</div>
    </div>
  </section>;
}
function CoachEvent({ event }: { event: CounselingEvent }) { return <article className={`counseling-event ${event.severity}`}><div>{event.severity === "critical" ? <ShieldAlert size={16}/> : event.kind === "interruption" ? <VolumeX size={16}/> : <Sparkles size={16}/>}<strong>{event.title}</strong></div><p>{event.suggestion}</p><small>证据：{event.evidence}</small></article>; }
function Report({ report, session }: { report: NonNullable<CounselingSession["report"]>; session: CounselingSession }) { return <section className="counseling-report"><header><div><span>训练复盘</span><h2>{report.overallScore} 分</h2></div><a href={`/api/counseling/sessions/${encodeURIComponent(session.id)}/report`} download>下载 MD</a></header><div className="counseling-score-list">{report.dimensions.map(item => <div key={item.name} className={!item.applicable ? "is-na" : ""}><span>{item.name}</span><i><b style={{ width: `${item.applicable ? item.score : 0}%` }}/></i><strong>{item.applicable ? item.score : "未考察"}</strong></div>)}</div><p><strong>下一轮：</strong>{report.nextTask}</p><small>打断：辅导员 {report.interruptions.counselor} 次 · 学生 {report.interruptions.student} 次 · 修复 {report.interruptions.repairs} 次。评分为规则辅助评价，需人工复核。</small></section>; }
