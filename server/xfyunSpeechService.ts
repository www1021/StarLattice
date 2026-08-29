import crypto from "node:crypto";
import { URL } from "node:url";
import { WebSocket } from "ws";

export type XfyunSpeechConfig = {
  appId: string;
  apiKey: string;
  apiSecret: string;
  iatUrl: string;
  ttsUrl: string;
};

export type XfyunIatHandlers = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (message: string) => void;
};

type XfyunIatResponse = {
  code?: number;
  message?: string;
  data?: {
    status?: number;
    result?: {
      ws?: Array<{
        cw?: Array<{
          w?: string;
        }>;
      }>;
    };
  };
};

type XfyunTtsResponse = {
  code?: number;
  message?: string;
  data?: {
    audio?: string;
    status?: number;
  };
};

const DEFAULT_IAT_URL = "wss://iat-api.xfyun.cn/v2/iat";
const DEFAULT_TTS_URL = "wss://tts-api.xfyun.cn/v2/tts";

export class XfyunSpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XfyunSpeechError";
  }
}

export function getXfyunSpeechConfig(): XfyunSpeechConfig | undefined {
  const appId = process.env.SPEAK_IFLYTEK_APP_ID;
  const apiKey = process.env.SPEAK_IFLYTEK_API_KEY;
  const apiSecret = process.env.SPEAK_IFLYTEK_API_SECRET;

  if (!appId || !apiKey || !apiSecret) {
    return undefined;
  }

  return {
    appId,
    apiKey,
    apiSecret,
    iatUrl: process.env.SPEAK_IFLYTEK_IAT_URL || DEFAULT_IAT_URL,
    ttsUrl: process.env.SPEAK_IFLYTEK_TTS_URL || DEFAULT_TTS_URL
  };
}

export function isXfyunSpeechConfigured() {
  return Boolean(getXfyunSpeechConfig());
}

export class XfyunIatStream {
  private socket?: WebSocket;
  private openPromise?: Promise<void>;
  private frameStarted = false;
  private closed = false;
  private finishResolve?: () => void;
  private finishTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: XfyunSpeechConfig,
    private readonly handlers: XfyunIatHandlers
  ) {}

  async connect() {
    if (this.openPromise) {
      return this.openPromise;
    }

    this.openPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(buildSignedUrl(this.config.iatUrl, this.config), {
        handshakeTimeout: 6000
      });
      const connectTimer = setTimeout(() => {
        const message = "讯飞听写连接超时，请检查网络、讯飞服务地址或应用权限。";
        this.handlers.onError(message);
        socket.terminate();
        reject(new XfyunSpeechError(message));
      }, 6500);
      this.socket = socket;

      socket.on("open", () => {
        clearTimeout(connectTimer);
        console.info("[xfyun:iat] websocket opened");
        resolve();
      });
      socket.on("message", (data) => this.handleMessage(String(data)));
      socket.on("error", (error) => {
        clearTimeout(connectTimer);
        const message = error instanceof Error ? error.message : "讯飞听写连接失败";
        this.handlers.onError(message);
        reject(error);
      });
      socket.on("unexpected-response", (_request, response) => {
        clearTimeout(connectTimer);
        const message = `讯飞听写握手失败：HTTP ${response.statusCode}`;
        this.handlers.onError(message);
        reject(new XfyunSpeechError(message));
      });
      socket.on("close", () => {
        clearTimeout(connectTimer);
        this.closed = true;
      });
    });

    return this.openPromise;
  }

  async sendAudioFrame(audioBase64: string) {
    if (this.closed) {
      return;
    }

    await this.connect();
    this.send(
      this.frameStarted
        ? buildIatFrame(this.config.appId, 1, audioBase64)
        : buildIatFrame(this.config.appId, 0, audioBase64)
    );
    this.frameStarted = true;
  }

  async finish() {
    if (this.closed) {
      return;
    }

    await this.connect();
    this.send(buildIatFrame(this.config.appId, 2, ""));
    await new Promise<void>((resolve) => {
      this.finishResolve = resolve;
      this.finishTimer = setTimeout(() => {
        this.handlers.onError("讯飞听写未返回最终识别结果，请检查麦克风音量、音频权限或听写额度。");
        this.close();
        resolve();
      }, 1800);
    });
  }

  close() {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = undefined;
    }
    this.socket?.close(1000, "closed");
    this.closed = true;
    this.finishResolve?.();
    this.finishResolve = undefined;
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private handleMessage(raw: string) {
    let payload: XfyunIatResponse;

    try {
      payload = JSON.parse(raw) as XfyunIatResponse;
    } catch {
      this.handlers.onError("讯飞听写返回了无法解析的数据。");
      return;
    }

    if (payload.code && payload.code !== 0) {
      this.handlers.onError(payload.message || `讯飞听写错误：${payload.code}`);
      return;
    }

    const text = extractIatText(payload);
    console.info(
      `[xfyun:iat] code=${payload.code ?? 0} status=${payload.data?.status ?? "unknown"} textLength=${text.length}`
    );

    if (text) {
      this.handlers.onTranscript(text, payload.data?.status === 2);
    }

    if (payload.data?.status === 2) {
      this.close();
    }
  }
}

export async function synthesizeXfyunSpeech(input: {
  text: string;
  role?: "researcher" | "teacher" | "expert" | "system";
}) {
  const config = getXfyunSpeechConfig();

  if (!config) {
    throw new XfyunSpeechError("讯飞语音未配置，请补充 AppID、APIKey 和 APISecret。");
  }

  const text = input.text.trim();

  if (!text) {
    throw new XfyunSpeechError("合成文本不能为空。");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await synthesizeXfyunSpeechOnce(config, {
        text,
        role: input.role
      });
    } catch (error) {
      lastError = error;
      console.warn(
        `[xfyun:tts] attempt=${attempt} failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new XfyunSpeechError("讯飞语音合成失败。");
}

function synthesizeXfyunSpeechOnce(
  config: XfyunSpeechConfig,
  input: {
    text: string;
    role?: "researcher" | "teacher" | "expert" | "system";
  }
) {
  return new Promise<{ audioBase64: string; contentType: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new WebSocket(buildSignedUrl(config.ttsUrl, config), {
      handshakeTimeout: 8000
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new XfyunSpeechError("讯飞语音合成连接超时。"));
    }, 12000);

    socket.on("open", () => {
      socket.send(JSON.stringify(buildTtsFrame(config.appId, input.text, input.role)));
    });
    socket.on("message", (data) => {
      let payload: XfyunTtsResponse;

      try {
        payload = JSON.parse(String(data)) as XfyunTtsResponse;
      } catch {
        reject(new XfyunSpeechError("讯飞语音合成返回了无法解析的数据。"));
        socket.close();
        return;
      }

      if (payload.code && payload.code !== 0) {
        clearTimeout(timer);
        reject(new XfyunSpeechError(payload.message || `讯飞语音合成错误：${payload.code}`));
        socket.close();
        return;
      }

      if (payload.data?.audio) {
        chunks.push(Buffer.from(payload.data.audio, "base64"));
      }

      if (payload.data?.status === 2) {
        clearTimeout(timer);
        socket.close(1000, "finished");
        resolve({
          audioBase64: Buffer.concat(chunks).toString("base64"),
          contentType: "audio/mpeg"
        });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new XfyunSpeechError(
          error instanceof Error ? error.message : "讯飞语音合成连接失败。"
        )
      );
    });
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      reject(new XfyunSpeechError(`讯飞语音合成握手失败：HTTP ${response.statusCode}`));
    });
    socket.on("close", () => {
      clearTimeout(timer);
    });
  });
}

function buildSignedUrl(rawUrl: string, config: XfyunSpeechConfig) {
  const url = new URL(rawUrl);
  const date = new Date().toUTCString();
  const signatureOrigin = [
    `host: ${url.host}`,
    `date: ${date}`,
    `GET ${url.pathname} HTTP/1.1`
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", config.apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin = `api_key="${config.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  url.searchParams.set(
    "authorization",
    Buffer.from(authorizationOrigin).toString("base64")
  );
  url.searchParams.set("date", date);
  url.searchParams.set("host", url.host);
  return url.toString();
}

function buildIatFrame(appId: string, status: 0 | 1 | 2, audioBase64: string) {
  const data = {
    status,
    format: "audio/L16;rate=16000",
    encoding: "raw",
    audio: audioBase64
  };

  if (status === 0) {
    return {
      common: {
        app_id: appId
      },
      business: {
        language: "zh_cn",
        domain: "iat",
        accent: "mandarin",
        vad_eos: Number(process.env.SPEAK_IFLYTEK_VAD_EOS || 4000)
      },
      data
    };
  }

  return {
    data
  };
}

function buildTtsFrame(
  appId: string,
  text: string,
  role?: "researcher" | "teacher" | "expert" | "system"
) {
  const voice = getRoleVoice(role);
  return {
    common: {
      app_id: appId
    },
    business: {
      aue: "lame",
      sfl: 1,
      auf: "audio/L16;rate=16000",
      vcn: voice.vcn,
      speed: voice.speed,
      volume: voice.volume,
      pitch: voice.pitch,
      bgs: 0,
      tte: "UTF8"
    },
    data: {
      status: 2,
      text: Buffer.from(text, "utf8").toString("base64")
    }
  };
}

function getRoleVoice(role?: "researcher" | "teacher" | "expert" | "system") {
  const roleKey = role ? role.toUpperCase() : "SYSTEM";
  const vcn =
    process.env[`SPEAK_IFLYTEK_TTS_VCN_${roleKey}`] ||
    process.env.SPEAK_IFLYTEK_TTS_VCN ||
    "xiaoyan";

  if (role === "researcher") {
    return { vcn, speed: 42, volume: 55, pitch: 42 };
  }

  if (role === "expert") {
    return { vcn, speed: 48, volume: 55, pitch: 46 };
  }

  return { vcn, speed: 52, volume: 55, pitch: 50 };
}

function extractIatText(payload: XfyunIatResponse) {
  return (
    payload.data?.result?.ws
      ?.flatMap((item) => item.cw || [])
      .map((item) => item.w || "")
      .join("") || ""
  );
}
