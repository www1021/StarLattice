import { Mic, Send } from "lucide-react";

type TeacherInputBarProps = {
  value: string;
  disabled: boolean;
  isSubmitting: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onFinish: () => void;
  onStartVoice: () => void;
  onStopVoice: () => void;
  isListening: boolean;
  voiceSupported: boolean;
  voiceStatus: string;
  interimTranscript: string;
};

export function TeacherInputBar({
  value,
  disabled,
  isSubmitting,
  onChange,
  onSend,
  onFinish,
  onStartVoice,
  onStopVoice,
  isListening,
  voiceSupported,
  voiceStatus,
  interimTranscript
}: TeacherInputBarProps) {
  return (
    <section className="teacher-input-bar" aria-label="教师输入区">
      <div className={`voice-status-row ${isListening ? "listening" : ""}`}>
        <Mic size={16} strokeWidth={2.2} />
        <span>{voiceSupported ? voiceStatus : "当前浏览器不支持语音识别，请使用文字输入。"}</span>
      </div>
      <textarea
        value={interimTranscript ? `${value}${value ? "\n" : ""}${interimTranscript}` : value}
        disabled={disabled || isSubmitting}
        onChange={(event) => onChange(event.target.value)}
        placeholder="以教师身份开始试讲，例如：同学们想一想，为什么这个方法可行？"
      />
      <div className="teacher-input-actions">
        <button type="button" onClick={onSend} disabled={disabled || isSubmitting || !value.trim()}>
          <Send size={17} strokeWidth={2.2} />
          <span>{isSubmitting ? "处理中" : "发送讲课"}</span>
        </button>
        <button
          className={`voice-reserved ${isListening ? "listening" : ""}`}
          type="button"
          onClick={isListening ? onStopVoice : onStartVoice}
          disabled={disabled || isSubmitting || !voiceSupported}
        >
          <Mic size={17} strokeWidth={2.2} />
          <span>{isListening ? "停止语音" : "开始语音讲课"}</span>
        </button>
        <button className="finish-training" type="button" onClick={onFinish} disabled={disabled || isSubmitting}>
          {isSubmitting ? "正在生成报告" : "结束训练并生成报告"}
        </button>
      </div>
    </section>
  );
}
