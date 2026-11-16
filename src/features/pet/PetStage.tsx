import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { castById, MAIN_CAST_ID, poseOf, type PetPose } from "./petCast";
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
  pulling
}: {
  pose: PetPose;
  blinkPose?: PetPose;
  blinkOn?: boolean;
  pressed?: boolean;
  onPressEnd?: () => void;
  showSparks?: boolean;
  pulling?: boolean;
}) {
  const scale = pose.scale ?? 1;
  return (
    <div className="pet-figure">
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

      {pulling ? <div className="pet-pull-marks" aria-hidden="true" /> : null}
    </div>
  );
}

export function PetStage() {
  const mood = usePetStore((state) => state.mood);
  const caption = usePetStore((state) => state.caption);
  const helper = usePetStore((state) => state.helper);
  const blinking = usePetStore((state) => state.blinking);
  const press = usePetStore((state) => state.press);

  const main = castById(MAIN_CAST_ID);
  const helperCast = helper ? castById(helper.castId) : null;

  // 点击：压一下 + 眨个眼。间隔要大于压缩动画本身（0.52s），
  // 否则上一段还没播完就再点，动画不会重新开始。
  const [pressed, setPressed] = useState(false);
  const lastPressRef = useRef(0);
  const onPress = useCallback(() => {
    const now = Date.now();
    if (now - lastPressRef.current < 560) return;
    lastPressRef.current = now;
    setPressed(true);
    press();
  }, [press]);

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

  const mainPose = poseOf(main, mood);

  return (
    <section
      className="pet-stage"
      data-mood={mood}
      data-peek={peek ? "1" : "0"}
      data-helper={helper ? "1" : "0"}
      aria-label="工作宠"
    >
      <AnimatePresence>
        {caption ? (
          <motion.div
            key={caption}
            className="pet-bubble"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
          >
            {caption}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="pet-cast">
        {/* 主角：有人接手时退到左边只露半个身子，像在旁边看着人家干活 */}
        <motion.div
          className="pet-actor is-main"
          animate={{
            x: helper ? -62 : 0,
            scale: helper ? 0.5 : 1,
            opacity: helper ? 0.5 : 1,
            rotate: helper ? -6 : 0
          }}
          transition={{ type: "spring", stiffness: 200, damping: 22 }}
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

        {/* 被拽上来的专项 Agent：从左边被拉进来，带一点被拽歪的过冲 */}
        <AnimatePresence>
          {helper && helperCast ? (
            <motion.div
              key={helper.castId + helper.name}
              className="pet-actor is-helper"
              initial={{ x: -74, rotate: -16, scale: 0.68, opacity: 0 }}
              animate={{ x: 30, rotate: 0, scale: 0.82, opacity: 1 }}
              exit={{ x: -88, rotate: -12, scale: 0.74, opacity: 0 }}
              transition={{
                type: "spring",
                stiffness: 240,
                damping: 15,
                opacity: { duration: 0.18 }
              }}
            >
              <Figure pose={poseOf(helperCast, "idle")} pulling />
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
