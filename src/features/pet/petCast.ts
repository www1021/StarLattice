// 工作宠角色表：7 只小新，每只一套四态立绘 + 一套标志性动作。
// 所有立绘都出自同一只蜡笔小新的不同造型：同一张脸、同一画风，
// 换角色/换状态都不该让人觉得"跑偏成别人"。

import petIdle from "../../images/pet/pet-idle.webp";
import petIdleBlink from "../../images/pet/pet-idle-blink.webp";
import petRunning from "../../images/pet/pet-running.webp";
import petSuccess from "../../images/pet/pet-success.webp";
import petError from "../../images/pet/pet-error.webp";
import petPull from "../../images/pet/pet-pull.webp";
import petFriendDrag from "../../images/pet/pet-friend-drag.webp";

import actionIdle from "../../images/pet/action/idle.webp";
import actionRunning from "../../images/pet/action/running.webp";
import actionSuccess from "../../images/pet/action/success.webp";
import actionError from "../../images/pet/action/error.webp";

import maskIdle from "../../images/pet/mask/idle.webp";
import maskRunning from "../../images/pet/mask/running.webp";
import maskSuccess from "../../images/pet/mask/success.webp";
import maskError from "../../images/pet/mask/error.webp";

import danceIdle from "../../images/pet/dance/idle.webp";
import danceRunning from "../../images/pet/dance/running.webp";
import danceSuccess from "../../images/pet/dance/success.webp";
import danceError from "../../images/pet/dance/error.webp";

import uniformIdle from "../../images/pet/uniform/idle.webp";
import uniformRunning from "../../images/pet/uniform/running.webp";
import uniformSuccess from "../../images/pet/uniform/success.webp";
import uniformError from "../../images/pet/uniform/error.webp";

import headbandIdle from "../../images/pet/headband/idle.webp";
import headbandRunning from "../../images/pet/headband/running.webp";
import headbandSuccess from "../../images/pet/headband/success.webp";
import headbandError from "../../images/pet/headband/error.webp";

import kingIdle from "../../images/pet/king/idle.webp";
import kingRunning from "../../images/pet/king/running.webp";
import kingSuccess from "../../images/pet/king/success.webp";
import kingError from "../../images/pet/king/error.webp";

/** 工作宠的四种状态，每个状态对应一张立绘。 */
export type PetMood = "idle" | "running" | "success" | "error";

export type PetPose = {
  src: string;
  /** 宽 / 高，用来按高度摆位时算宽度 */
  ratio: number;
  /** 同高度下人物的视觉大小修正 */
  scale?: number;
};

/** 标志性动作包：决定待机时的动画风格，由 CSS 的 data-motion 消费。 */
export type MotionId = "default" | "guard" | "strut" | "groove" | "march" | "cheer" | "royal";

export type PetCharacter = {
  id: string;
  name: string;
  /** 一句话介绍，设置面板里展示 */
  tagline: string;
  /** 这只的默认专属动作 */
  motion: MotionId;
  /** 缺哪个状态就回落到 idle */
  poses: { idle: PetPose } & Partial<Record<Exclude<PetMood, "idle">, PetPose>>;
  /** 闭眼帧：只有原版小新做了，点击时才闪一下 */
  blink?: PetPose;
  /** 转交时把人拽进来的那一下：主角伸手拉、对方被拖着抵抗 */
  pullPose?: PetPose;
  /** 被拽进来之后不情愿干活的姿态 */
  dragPose?: PetPose;
};

/** 动作包清单，设置面板里给用户挑（"专属动作"= 该角色默认那套）。 */
export const MOTIONS: Array<{ id: MotionId; label: string; hint: string }> = [
  { id: "default", label: "招牌待机", hint: "伸懒腰、晃一晃" },
  { id: "guard", label: "动感出拳", hint: "举盾、蓄力挥拳" },
  { id: "strut", label: "神气踱步", hint: "叉腰、昂首挺胸" },
  { id: "groove", label: "扭扭舞步", hint: "左右摇摆、踩节奏" },
  { id: "march", label: "精神列队", hint: "挺直、原地踏步" },
  { id: "cheer", label: "加油打气", hint: "举双手、上下挥动" },
  { id: "royal", label: "王者挥手", hint: "优雅抬手、转圈" }
];

/** 原版小新：待在舞台上，转交时伸手把下一位拽上来。 */
export const XIAOXIN: PetCharacter = {
  id: "xiaoxin",
  name: "小新",
  tagline: "吃着冰棍的原始担当",
  motion: "default",
  poses: {
    idle: { src: petIdle, ratio: 545 / 760 },
    running: { src: petRunning, ratio: 543 / 760 },
    success: { src: petSuccess, ratio: 729 / 760 },
    error: { src: petError, ratio: 502 / 760 }
  },
  blink: { src: petIdleBlink, ratio: 545 / 760 },
  pullPose: { src: petPull, ratio: 570 / 760 }
};

const ACTION: PetCharacter = {
  id: "action",
  name: "动感超人",
  tagline: "举盾出击，正义的伙伴",
  motion: "guard",
  poses: {
    idle: { src: actionIdle, ratio: 1.1434 },
    running: { src: actionRunning, ratio: 0.8513 },
    success: { src: actionSuccess, ratio: 0.8658 },
    error: { src: actionError, ratio: 0.7039 }
  },
  pullPose: { src: actionRunning, ratio: 0.8513 }
};

const MASK: PetCharacter = {
  id: "mask",
  name: "蒙面小新",
  tagline: "戴上面罩也一样神气",
  motion: "strut",
  poses: {
    idle: { src: maskIdle, ratio: 0.8645 },
    running: { src: maskRunning, ratio: 0.853 },
    success: { src: maskSuccess, ratio: 1.021 },
    error: { src: maskError, ratio: 0.88 }
  },
  pullPose: { src: maskRunning, ratio: 0.853 }
};

const DANCE: PetCharacter = {
  id: "dance",
  name: "跳舞小新",
  tagline: "跟着节奏扭起来",
  motion: "groove",
  poses: {
    idle: { src: danceIdle, ratio: 1.1829 },
    running: { src: danceRunning, ratio: 0.876 },
    success: { src: danceSuccess, ratio: 0.918 },
    error: { src: danceError, ratio: 0.653 }
  },
  pullPose: { src: danceRunning, ratio: 0.876 }
};

const UNIFORM: PetCharacter = {
  id: "uniform",
  name: "制服小新",
  tagline: "背着书包精神满满",
  motion: "march",
  poses: {
    idle: { src: uniformIdle, ratio: 0.7184 },
    running: { src: uniformRunning, ratio: 0.784 },
    success: { src: uniformSuccess, ratio: 0.928 },
    error: { src: uniformError, ratio: 0.674 }
  },
  pullPose: { src: uniformRunning, ratio: 0.784 }
};

const HEADBAND: PetCharacter = {
  id: "headband",
  name: "运动小新",
  tagline: "系上头带，为你加油",
  motion: "cheer",
  poses: {
    idle: { src: headbandIdle, ratio: 0.9526 },
    running: { src: headbandRunning, ratio: 0.809 },
    success: { src: headbandSuccess, ratio: 0.959 },
    error: { src: headbandError, ratio: 0.768 }
  },
  pullPose: { src: headbandRunning, ratio: 0.809 }
};

const KING: PetCharacter = {
  id: "king",
  name: "国王小新",
  tagline: "戴上王冠，气场全开",
  motion: "royal",
  poses: {
    idle: { src: kingIdle, ratio: 0.7697 },
    running: { src: kingRunning, ratio: 0.762 },
    success: { src: kingSuccess, ratio: 0.838 },
    error: { src: kingError, ratio: 0.63 }
  },
  pullPose: { src: kingRunning, ratio: 0.762 }
};

/** 被拽上来的那位——同源的另一只小新，只是表情不情愿。 */
export const MATE: PetCharacter = {
  id: "mate",
  name: "小新同伴",
  tagline: "",
  motion: "default",
  poses: {
    idle: { src: petFriendDrag, ratio: 546 / 760 },
    running: { src: petFriendDrag, ratio: 546 / 760 }
  },
  dragPose: { src: petFriendDrag, ratio: 546 / 760 }
};

/** 用户可在设置里任选的 7 只小新（配角 mate 不在列表里）。 */
export const SELECTABLE_CAST: PetCharacter[] = [
  XIAOXIN, ACTION, MASK, DANCE, UNIFORM, HEADBAND, KING
];

/** 所有角色（含配角），供 castById 查表。 */
export const CAST: PetCharacter[] = [...SELECTABLE_CAST, MATE];

export const MAIN_CAST_ID = XIAOXIN.id;

/**
 * 转交给专项 Agent 时由谁出场。
 * 用 Agent 名字做确定性映射，让不同专项 Agent 轮换不同造型的小新，画面更丰富。
 */
const AGENT_CAST_MAP: Record<string, string> = {
  "文献阅读Agent": "uniform",
  "教学设计Agent": "king",
  "课堂观察Agent": "action",
  "学情诊断Agent": "mask",
  "经营分析Agent": "headband"
};

export function castForAgent(agentName: string): PetCharacter {
  const id = AGENT_CAST_MAP[agentName];
  return id ? castById(id) : MATE;
}

export function castById(id: string): PetCharacter {
  return CAST.find((item) => item.id === id) ?? XIAOXIN;
}

export function poseOf(cast: PetCharacter, mood: PetMood): PetPose {
  return cast.poses[mood] ?? cast.poses.idle;
}
