import petIdle from "../../images/pet/pet-idle.webp";
import petIdleBlink from "../../images/pet/pet-idle-blink.webp";
import petRunning from "../../images/pet/pet-running.webp";
import petSuccess from "../../images/pet/pet-success.webp";
import petError from "../../images/pet/pet-error.webp";
import petPull from "../../images/pet/pet-pull.webp";
import petFriendDrag from "../../images/pet/pet-friend-drag.webp";

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
  /** 转交时把人拽进来的那一下：主角伸手拉、对方被拖着抵抗 */
  pullPose?: PetPose;
  /** 被拽进来之后不情愿干活的姿态 */
  dragPose?: PetPose;
};

/** 主角小新：待在舞台上，转交时伸手把下一位拽上来 */
export const XIAOXIN: PetCharacter = {
  id: "xiaoxin",
  name: "小新",
  poses: {
    idle: { src: petIdle, ratio: 545 / 760 },
    running: { src: petRunning, ratio: 543 / 760 },
    success: { src: petSuccess, ratio: 729 / 760 },
    error: { src: petError, ratio: 502 / 760 }
  },
  blink: { src: petIdleBlink, ratio: 545 / 760 },
  pullPose: { src: petPull, ratio: 570 / 760 }
};

/**
 * 被拽上来的那位——也是小新，同一个母版出的图，只是表情不情愿。
 * 名字按被转交的 Agent 动态显示，形象统一用这一套。
 */
export const MATE: PetCharacter = {
  id: "mate",
  name: "小新同伴",
  poses: {
    idle: { src: petFriendDrag, ratio: 546 / 760 },
    running: { src: petFriendDrag, ratio: 546 / 760 }
  },
  dragPose: { src: petFriendDrag, ratio: 546 / 760 }
};

export const CAST: PetCharacter[] = [XIAOXIN, MATE];

/** 主角固定是小新，平时待在舞台上；其他人只在被转交时出场。 */
export const MAIN_CAST_ID = XIAOXIN.id;

/**
 * 转交给专项 Agent 时由谁出场。
 * 现在只有一个配角形象（另一只小新），以后加了新形象在这里按名字分流即可。
 */
export function castForAgent(_agentName: string): PetCharacter {
  return MATE;
}

export function castById(id: string): PetCharacter {
  return CAST.find((item) => item.id === id) ?? XIAOXIN;
}

export function poseOf(cast: PetCharacter, mood: PetMood): PetPose {
  return cast.poses[mood] ?? cast.poses.idle;
}
