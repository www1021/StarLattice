import petIdle from "../../images/pet/pet-idle.webp";
import petIdleBlink from "../../images/pet/pet-idle-blink.webp";
import petRunning from "../../images/pet/pet-running.webp";
import petSuccess from "../../images/pet/pet-success.webp";
import petError from "../../images/pet/pet-error.webp";
import friendIdle from "../../images/pet/pet-friend-idle.webp";

/**
 * 工作宠的四种状态，每个状态对应一张立绘。
 * 所有立绘都出自同一个母版：同一张脸、同一身衣服，只是姿态和表情不同，
 * 换状态的时候不能让人觉得"换了一个人"。
 */
export type PetMood = "idle" | "running" | "success" | "error";

export type PetPose = {
  src: string;
  /** 宽 / 高，用来按高度摆位时算宽度 */
  ratio: number;
  /** 同高度下人物的视觉大小修正 */
  scale?: number;
};

export type PetCharacter = {
  id: string;
  name: string;
  /** 缺哪个状态就回落到 idle */
  poses: { idle: PetPose } & Partial<Record<Exclude<PetMood, "idle">, PetPose>>;
  /** 闭眼帧：只给主角做了，点击时才闪一下 */
  blink?: PetPose;
};

export const XIAOXIN: PetCharacter = {
  id: "xiaoxin",
  name: "小新",
  poses: {
    idle: { src: petIdle, ratio: 545 / 760 },
    running: { src: petRunning, ratio: 543 / 760 },
    success: { src: petSuccess, ratio: 729 / 760 },
    error: { src: petError, ratio: 502 / 760 }
  },
  blink: { src: petIdleBlink, ratio: 545 / 760 }
};

/**
 * 配角：被主角"拽"上来干活的专项 Agent。
 * 只有一张立绘，动作全靠 CSS 演——她本来就不情愿，动作慢半拍正好。
 */
export const XIAONAN: PetCharacter = {
  id: "xiaonan",
  name: "小南",
  poses: {
    idle: { src: friendIdle, ratio: 444 / 760, scale: 0.94 }
  }
};

export const CAST: PetCharacter[] = [XIAOXIN, XIAONAN];

/** 主角固定是小新，平时待在舞台上；其他人只在被转交时出场。 */
export const MAIN_CAST_ID = XIAOXIN.id;

/**
 * 转交给专项 Agent 时由谁出场。
 * 现在只有两个形象，除了主角之外统一由小南代演；
 * 以后加了新形象，在这里按智能体名字加规则即可，比如：
 *   if (/文献|检索|期刊/.test(agentName)) return WENXIAN;
 */
export function castForAgent(_agentName: string): PetCharacter {
  return XIAONAN;
}

export function castById(id: string): PetCharacter {
  return CAST.find((item) => item.id === id) ?? XIAOXIN;
}

export function poseOf(cast: PetCharacter, mood: PetMood): PetPose {
  return cast.poses[mood] ?? cast.poses.idle;
}
