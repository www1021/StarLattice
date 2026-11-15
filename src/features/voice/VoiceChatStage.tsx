import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Mic, Square } from "lucide-react";

type VoiceStageStatus = "idle" | "starting" | "listening" | "speaking" | "error";

type VoiceChatStageProps = {
  title?: string;
  onClose?: () => void;
};

const silenceHoldMs = 700;
const loudThreshold = 0.04;

const statusLabel: Record<VoiceStageStatus, string> = {
  idle: "点击下方按钮开始对话",
  starting: "正在开启麦克风…",
  listening: "我在听，请说话…",
  speaking: "正在说话",
  error: "麦克风不可用"
};

/* 平滑噪声：多组正弦叠加，输出约 -1 ~ 1，用来驱动光球的游移与抖动 */
function smoothNoise(t: number, seed: number) {
  return (
    Math.sin(t * 1.35 + seed * 12.9) * 0.55 +
    Math.sin(t * 2.87 + seed * 78.2) * 0.28 +
    Math.sin(t * 5.11 + seed * 37.7) * 0.17
  );
}

export function VoiceChatStage({
  title = "语音对话",
  onClose
}: VoiceChatStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timeBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const micOnRef = useRef(false);
  const speakingRef = useRef(false);
  const statusRef = useRef<VoiceStageStatus>("idle");
  const levelRef = useRef(0);
  const lastLoudAtRef = useRef(0);
  const [status, setStatus] = useState<VoiceStageStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [micOn, setMicOn] = useState(false);

  const showStatus = useCallback((next: VoiceStageStatus, error = "") => {
    statusRef.current = next;
    setStatus(next);
    setErrorMessage(error);
  }, []);

  const stopMic = useCallback(() => {
    micOnRef.current = false;
    speakingRef.current = false;
    levelRef.current = 0;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
    timeBufRef.current = null;
    setMicOn(false);
    showStatus("idle");
  }, [showStatus]);

  const startMic = useCallback(async () => {
    if (micOnRef.current) {
      return;
    }

    showStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) {
        stream.getTracks().forEach((track) => track.stop());
        showStatus("error", "当前浏览器不支持 WebAudio。");
        return;
      }

      const audioContext = new AudioContextClass();
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      timeBufRef.current = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      micOnRef.current = true;
      speakingRef.current = false;
      levelRef.current = 0;
      lastLoudAtRef.current = performance.now();
      setMicOn(true);
      showStatus("listening");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus("error", `无法访问麦克风：${message}`);
    }
  }, [showStatus]);

  useEffect(() => stopMic, [stopMic]);

  /* 渲染循环：光球随麦克风采到的音量抖动，安静时回到轻微起伏 */
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");

    if (!stage || !canvas || !ctx) {
      return;
    }

    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = stage.clientWidth;
      height = stage.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);

    const pollAudio = () => {
      const analyser = analyserRef.current;
      const timeBuf = timeBufRef.current;

      if (!analyser || !timeBuf || !micOnRef.current) {
        return;
      }

      analyser.getFloatTimeDomainData(timeBuf);
      let sum = 0;
      for (let index = 0; index < timeBuf.length; index += 1) {
        sum += timeBuf[index] * timeBuf[index];
      }
      const rms = Math.sqrt(sum / timeBuf.length);
      const now = performance.now();

      if (rms > loudThreshold) {
        lastLoudAtRef.current = now;
        speakingRef.current = true;
        if (statusRef.current !== "speaking") {
          setStatus("speaking");
        }
      } else if (speakingRef.current && now - lastLoudAtRef.current > silenceHoldMs) {
        speakingRef.current = false;
        setStatus("listening");
      }

      const instant = Math.min(1, rms * 16);
      const smoothing = instant > levelRef.current ? 0.45 : 0.1;
      levelRef.current += (instant - levelRef.current) * smoothing;
    };

    const drawCloud = (
      t: number,
      seed: number,
      bx: number,
      by: number,
      r: number,
      rgb: string,
      alpha: number,
      R: number,
      energy: number,
      level: number
    ) => {
      const wander = R * 0.16;
      const jitter = R * 0.05 * energy;
      const wx = bx * R + smoothNoise(t * 0.9 + seed, seed * 3.3) * wander + smoothNoise(t * 15.7, seed * 6.1) * jitter;
      const wy = by * R + smoothNoise(t * 0.8 + seed * 2.2, seed * 7.7) * wander + smoothNoise(t * 13.3, seed * 9.2) * jitter;
      const rr = r * R * (1 + 0.08 * smoothNoise(t * 1.1, seed) + 0.14 * level);
      const gradient = ctx.createRadialGradient(wx, wy, 0, wx, wy, rr);
      gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
      gradient.addColorStop(0.55, `rgba(${rgb},${alpha * 0.55})`);
      gradient.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(wx, wy, rr, 0, Math.PI * 2);
      ctx.fill();
    };

    let frame = 0;

    const render = (now: number) => {
      pollAudio();
      const t = now / 1000;
      const level = levelRef.current;
      const isSpeaking = speakingRef.current;
      const energy = isSpeaking ? 1.8 + level * 2 : 1;

      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.3);
      const R = Math.min(width, height) * 0.16 * (1 + 0.035 * breathe + 0.14 * level);

      const shakeAmp = isSpeaking ? 1.5 + level * 16 : 1.1;
      const sx = smoothNoise(t * 12.3, 3.1) * shakeAmp;
      const sy = smoothNoise(t * 10.7, 8.7) * shakeAmp;

      // 柔和投影，让光球在浅色玻璃上浮起来
      const shadow = ctx.createRadialGradient(cx + sx, cy + sy + R * 0.1, R * 0.2, cx + sx, cy + sy + R * 0.12, R * 1.6);
      shadow.addColorStop(0, "rgba(70, 90, 180, 0.32)");
      shadow.addColorStop(0.6, "rgba(70, 90, 180, 0.12)");
      shadow.addColorStop(1, "rgba(70, 90, 180, 0)");
      ctx.fillStyle = shadow;
      ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);

      // 微光晕，用更深一点的靛蓝，浅色背景下仍可见
      const glow = ctx.createRadialGradient(cx + sx, cy + sy, R, cx + sx, cy + sy, R * 2.2);
      glow.addColorStop(0, `rgba(96,118,246,${0.12 + level * 0.18})`);
      glow.addColorStop(1, "rgba(96,118,246,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(cx + sx, cy + sy);

      const wobble = isSpeaking ? 0.012 + level * 0.05 : 0.008;
      const segments = 96;
      ctx.beginPath();
      for (let index = 0; index <= segments; index += 1) {
        const angle = (index / segments) * Math.PI * 2;
        const rr =
          R *
          (1 + wobble * (Math.sin(angle * 3 + t * 5.1) * 0.6 + Math.sin(angle * 5 - t * 3.7 + 1.7) * 0.4));
        const x = Math.cos(angle) * rr;
        const y = Math.sin(angle) * rr;
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.clip();

      const base = ctx.createRadialGradient(0, -R * 0.25, R * 0.05, 0, 0, R * 1.05);
      base.addColorStop(0, "#ffffff");
      base.addColorStop(0.5, "#eef1ff");
      base.addColorStop(0.82, "#c6d0f6");
      base.addColorStop(1, "#aab8f0");
      ctx.fillStyle = base;
      ctx.fillRect(-R * 1.4, -R * 1.4, R * 2.8, R * 2.8);

      const te = t * energy;
      drawCloud(te, 1, 0.18, -0.55, 0.85, "110,128,255", 0.9, R, energy, level);
      drawCloud(te, 2, -0.3, -0.6, 0.6, "86,100,240", 0.7, R, energy, level);
      drawCloud(te, 3, -0.05, 0.18, 0.9, "255,255,255", 0.95, R, energy, level);
      drawCloud(te, 4, 0.25, 0.55, 0.7, "175,188,255", 0.55, R, energy, level);

      ctx.restore();
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const toggleMic = () => {
    if (micOnRef.current) {
      stopMic();
    } else {
      void startMic();
    }
  };

  return (
    <div className="voice-room voice-room-immersive">
      <header className="voice-room-header">
        <div>
          <h1>{micOn ? "正在说课" : title}</h1>
        </div>
        <div className="voice-room-mode">
          {status !== "idle" ? (
            <span className={`voice-status-chip ${micOn ? "is-on" : ""}`}>
              <span className="voice-status-dot" />
              {statusLabel[status]}
            </span>
          ) : null}
          {onClose ? (
            <button
              className="voice-close-button"
              type="button"
              aria-label="退出说课"
              onClick={onClose}
            >
              <ArrowLeft size={18} />
              <span>退出说课</span>
            </button>
          ) : null}
        </div>
      </header>
      <div ref={stageRef} className="voice-stage-card">
        <canvas ref={canvasRef} className="voice-stage-canvas" />
        <div className="voice-stage-hud">
          {errorMessage ? <p className="voice-stage-error">{errorMessage}</p> : null}
          <button
            className={`voice-stage-button ${micOn ? "voice-stage-button-stop" : ""}`}
            type="button"
            onClick={toggleMic}
          >
            {micOn ? <Square size={16} /> : <Mic size={17} />}
            <span>{micOn ? "结束对话" : "开始对话"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
