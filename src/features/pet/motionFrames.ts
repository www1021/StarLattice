/** 待机动作的逐帧编排。
 *
 * 旧版每个动作只是在同一张待机图上做 ±2~5° 旋转，肉眼几乎看不出差别，
 * 全都是"晃一下"。这里改成在角色已有的几张同源立绘之间硬切帧：
 * - pull  : 伸手出拳（主角有专用图，其余角色回落到 running 的前伸臂）
 * - running: 迈步摆臂
 * - success: 双臂高举
 * 不同帧序列 + pet.css 里各自的身体编排，才做出出拳/挺胸/踏步/挥手的区别。
 * 所有帧都来自同一个角色的四态图，不会像另画那样跑偏成别人。
 */
import { poseOf, type MotionId, type PetCharacter, type PetPose } from "./petCast";

export type MotionFrameKey = "idle" | "running" | "success" | "error" | "pull";

export type MotionFrame = {
  key: MotionFrameKey;
  /** 这一帧停留毫秒数；单帧动作（hold=1 的特殊写法见 isStatic）直接常驻 */
  hold: number;
};

export type MotionSequence = {
  frames: MotionFrame[];
  /** 静态造型：不切帧，只靠 CSS 身体编排表现动作 */
  static?: boolean;
};

export const MOTION_SEQUENCES: Record<MotionId, MotionSequence> = {
  // 招牌待机：不换图，保留原来的呼吸/轻晃，安静耐看
  default: { frames: [{ key: "idle", hold: 1 }], static: true },

  // 动感出拳：蓄力 → 出拳（前伸手）→ 收 → 再出一拳
  guard: {
    frames: [
      { key: "idle", hold: 520 },
      { key: "pull", hold: 480 },
      { key: "idle", hold: 640 },
      { key: "pull", hold: 480 },
      { key: "idle", hold: 900 }
    ]
  },

  // 神气踱步：站定挺胸，靠 CSS 做昂首+左右挺胸的慢摆，不切图
  strut: { frames: [{ key: "idle", hold: 1 }], static: true },

  // 扭扭舞步：左右摇摆 + 手臂高低变化
  groove: {
    frames: [
      { key: "idle", hold: 360 },
      { key: "running", hold: 360 },
      { key: "success", hold: 360 },
      { key: "running", hold: 360 }
    ]
  },

  // 精神列队：站 ↔ 迈步交替，配合 CSS 的上下踏步
  march: {
    frames: [
      { key: "idle", hold: 440 },
      { key: "running", hold: 440 }
    ]
  },

  // 加油打气：站 → 双臂高举，配合 CSS 跳跃
  cheer: {
    frames: [
      { key: "idle", hold: 460 },
      { key: "success", hold: 620 }
    ]
  },

  // 王者挥手：双臂高举常驻，靠 CSS 做缓慢优雅的挥手
  royal: { frames: [{ key: "success", hold: 1 }], static: true }
};

/** 把帧 key 解析成角色真实存在的立绘；缺图按 idle 回落，绝不崩。 */
export function poseForFrame(cast: PetCharacter, key: MotionFrameKey): PetPose {
  if (key === "pull") {
    return cast.pullPose ?? cast.poses.running ?? cast.poses.idle;
  }
  return cast.poses[key] ?? poseOf(cast, "idle");
}
