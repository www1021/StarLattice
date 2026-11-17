import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { castById, MAIN_CAST_ID, poseOf, type MotionId, type PetPose } from "./petCast";
import { MOTION_SEQUENCES, poseForFrame } from "./motionFrames";
import { usePetStore } from "./petStore";
import "./pet.css";

const SPARK_COUNT = 7;

/** 画一张立绘：外面套三层不同周期的变形层，动作才不像匀速摆图。 */
function Figure({
  pose,
  blinkPose,
  blinkOn,
  pressed,
  onPressEnd,
  showSparks,
  variant
}: {
  pose: PetPose;
  blinkPose?: PetPose;
  blinkOn?: boolean;
  pressed?: boolean;
  onPressEnd?: () => void;
  showSparks?: boolean;
  /** main=主角；drag=正被拽；work=被拽来干活 */
  variant?: "main" | "drag" | "work";
}) {
  const scale = pose.scale ?? 1;
  const v = variant ?? "main";
  return (
    <div className="pet-figure" data-variant={v}>
      <div
        className="pet-l-press"
        data-press={pressed ? "1" : "0"}
        onAnimationEnd={(event) => {
          // 只认自己这层的结束事件，别被里面的星星/踮脚动画带跑
          if (event.target === event.currentTarget) onPressEnd?.();
        }}
      >
        <div className="pet-l-float">
          <div className="pet-l-sway">
            <div className="pet-l-breathe">
              <div className="pet-art-stack">
                <img
                  className="pet-art"
                  src={pose.src}
                  alt=""
                  draggable={false}
                  style={{ height: `${scale * 100}%`, width: `${pose.ratio * scale * 100}%` }}
                />
                {blinkPose ? (
                  <img
                    className={`pet-art pet-blink${blinkOn ? " is-on" : ""}`}
                    src={blinkPose.src}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    style={{ height: `${scale * 100}%`, width: `${blinkPose.ratio * scale * 100}%` }}
                  />
                ) : null}
                {/* 使劲时蹦出的青筋，只主角拉人那一下显示 */}
                {v === "main" && <span className="pet-effort" aria-hidden="true" />}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="pet-shadow" aria-hidden="true" />

      {showSparks ? (
        <div className="pet-sparks" aria-hidden="true">
          {Array.from({ length: SPARK_COUNT }).map((_, index) => {
            const angle = (index / SPARK_COUNT) * Math.PI * 2 - Math.PI / 2;
            return (
              <span
                key={index}
                style={{
                  ["--i" as string]: index,
                  ["--dx" as string]: `${Math.cos(angle) * 58}px`,
                  ["--dy" as string]: `${Math.sin(angle) * 46 - 22}px`
                }}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function PetStage({ castId, motionId }: { castId?: string; motionId?: string }) {
  const mood = usePetStore((state) => state.mood);
  const caption = usePetStore((state) => state.caption);
  const helper = usePetStore((state) => state.helper);
  const pullPhase = usePetStore((state) => state.pullPhase);
  const blinking = usePetStore((state) => state.blinking);

  const main = castById(castId ?? MAIN_CAST_ID);
  const helperCast = helper ? castById(helper.castId) : null;
  const pulling = pullPhase === "pulling";
  const working = pullPhase === "working";

  // 点击：压一下 + 眨个眼。间隔要大于压缩动画本身（0.52s），
  // 否则上一段还没播完就再点，动画不会重新开始。
  const [pressed, setPressed] = useState(false);
  const lastPressRef = useRef(0);
  const onPress = useCallback(() => {
    const now = Date.now();
    if (now - lastPressRef.current < 560) return;
    lastPressRef.current = now;
    setPressed(true);
    usePetStore.getState().press();
  }, []);

  // 待机时偶尔自己踮一下脚，间隔随机，避免一直一个节奏
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (mood !== "idle" || helper) {
      setPeek(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        setPeek(true);
        timer = setTimeout(() => {
          if (cancelled) return;
          setPeek(false);
          schedule();
        }, 1050);
      }, 5200 + Math.random() * 6200);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mood, helper]);

  const activeMotion = (motionId ?? main.motion) as MotionId;
  const sequence = MOTION_SEQUENCES[activeMotion] ?? MOTION_SEQUENCES.default;

  // 待机且没在转交时，按动作编排在角色已有的几张立绘之间切帧：
  // 出拳用前伸手、踱步站定、舞步/列队/加油都换姿势。工作态仍按状态走，
  // 否则跑流程时人物会在"出拳帧"和"跑步帧"之间乱跳。
  const [frameIndex, setFrameIndex] = useState(0);
  const motionActive = mood === "idle" && !helper && !pulling;
  const canCycle = motionActive && !!sequence && !sequence.static && sequence.frames.length >= 2;

  // 换动作/换角色/离开待机时回到第 0 帧
  useEffect(() => {
    setFrameIndex(0);
  }, [activeMotion, motionActive, castId]);

  // 每帧停留时长不同，所以用 setTimeout 逐帧排下一次，不用固定周期的 setInterval
  useEffect(() => {
    if (!canCycle || !sequence) return;
    const hold = sequence.frames[frameIndex % sequence.frames.length].hold;
    const timer = setTimeout(() => {
      setFrameIndex((i) => (i + 1) % sequence.frames.length);
    }, hold);
    return () => clearTimeout(timer);
  }, [canCycle, sequence, frameIndex]);

  const motionFrame = motionActive && sequence ? sequence.frames[frameIndex % sequence.frames.length] : undefined;
  // 主角拉人那一下切到"使劲伸手"的立绘；待机时按动作帧切姿势；其余按状态走
  const motionPose = motionFrame ? poseForFrame(main, motionFrame.key) : null;
  const mainPose = pulling && main.pullPose
    ? main.pullPose
    : motionPose ?? poseOf(main, mood);
  // 配角：被拽时和干活时用同一张不情愿的脸
  const matePose = (working && helperCast?.dragPose) || poseOf(helperCast ?? main, "running");

  return (
    <section
      className="pet-stage"
      data-mood={mood}
      data-motion={activeMotion}
      data-frame={motionFrame?.key ?? ""}
      data-peek={peek ? "1" : "0"}
      data-helper={helper ? "1" : "0"}
      data-pull={pulling ? "1" : "0"}
      data-work={working ? "1" : "0"}
      aria-label="工作宠"
    >
      <AnimatePresence>
        {caption ? (
          <motion.div
            key={caption}
            className="pet-bubble"
            initial={{ opacity: 0, y: 8, scale: 0.9, rotate: -3 }}
            animate={{ opacity: 1, y: 0, scale: 1, rotate: -2 }}
            exit={{ opacity: 0, y: -6, scale: 0.94, rotate: -2 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
          >
            {caption}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="pet-cast">
        {/* 主角：拉人时站在右边使劲，拉完退到左边看着；平时居中 */}
        <motion.div
          className="pet-actor is-main"
          animate={{
            x: pulling ? 46 : helper ? -70 : 0,
            scale: pulling ? 0.82 : helper ? 0.46 : 1,
            opacity: helper && !pulling ? 0.5 : 1,
            rotate: 0
          }}
          transition={{ type: "spring", stiffness: 210, damping: 22 }}
        >
          <Figure
            pose={mainPose}
            blinkPose={main.blink}
            blinkOn={blinking && mood === "idle" && !helper}
            pressed={pressed}
            onPressEnd={() => setPressed(false)}
            showSparks={mood === "success"}
          />
        </motion.div>

        {/* 绳索：主角使劲拉的那一下，两人之间绷一根绳 */}
        <AnimatePresence>
          {pulling ? (
            <motion.div
              key="rope"
              className="pet-rope"
              initial={{ opacity: 0, scaleX: 0.4 }}
              animate={{ opacity: 1, scaleX: 1 }}
              exit={{ opacity: 0, scaleX: 0.5 }}
              transition={{ duration: 0.18 }}
              aria-hidden="true"
            />
          ) : null}
        </AnimatePresence>

        {/* 被拽上来的小新：先 resist 抵抗着被拖近，再落到岗位上不情愿地干活 */}
        <AnimatePresence>
          {helper && helperCast ? (
            <motion.div
              key={helper.castId + helper.name}
              className="pet-actor is-helper"
              initial={{ x: -150, rotate: -14, scale: 0.72, opacity: 0 }}
              animate={{
                // 被拽的过程：猛地拖近 → 抵抗弹回 → 再拖 → 到位
                x: pulling ? [-150, -92, -118, -58, -82, -30] : 26,
                rotate: pulling ? [-14, -6, -11, -2, -7, 0] : 0,
                scale: pulling ? [0.6, 0.68, 0.64, 0.74, 0.7, 0.78] : 0.9,
                opacity: 1
              }}
              exit={{ x: -130, rotate: -12, scale: 0.74, opacity: 0 }}
              transition={
                pulling
                  ? { duration: 1.5, ease: "easeInOut", times: [0, 0.2, 0.4, 0.62, 0.8, 1] }
                  : { type: "spring", stiffness: 190, damping: 20 }
              }
            >
              <Figure pose={matePose} variant={pulling ? "drag" : "work"} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* 点击热区：只覆盖人物本身，不挡对话 */}
      <button
        type="button"
        className="pet-hit"
        onClick={onPress}
        aria-label={`${main.name}，点一下试试`}
      />
    </section>
  );
}
