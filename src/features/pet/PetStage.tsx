import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import petIdle from "../../images/pet/pet-idle.webp";
import petRunning from "../../images/pet/pet-running.webp";
import petSuccess from "../../images/pet/pet-success.webp";
import petError from "../../images/pet/pet-error.webp";
import { usePetStore, type PetMood } from "./petStore";
import "./pet.css";

/**
 * 四张立绘出自同一个母版（同一张脸、同一身衣服），只是姿态和表情不同。
 * 宽高比不一样（欢呼那张张开双臂最宽），统一按高度摆，
 * 举手的立绘外框含双臂，同高度下人会显小，单独放大一档。
 */
const ART: Record<PetMood, { src: string; ratio: number; scale: number }> = {
  idle: { src: petIdle, ratio: 545 / 760, scale: 1 },
  running: { src: petRunning, ratio: 543 / 760, scale: 1 },
  success: { src: petSuccess, ratio: 729 / 760, scale: 1 },
  error: { src: petError, ratio: 502 / 760, scale: 1 }
};

const MOOD_LABEL: Record<PetMood, string> = {
  idle: "待机",
  running: "工作中",
  success: "完成",
  error: "出错"
};

export function PetStage() {
  const mood = usePetStore((state) => state.mood);
  const caption = usePetStore((state) => state.caption);

  // 待机时偶尔自己动一下（踮脚 / 扭头），间隔随机，避免一直一个节奏。
  const [peek, setPeek] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (mood !== "idle") {
      setPeek(false);
      return;
    }
    let cancelled = false;
    const schedule = () => {
      const wait = 5200 + Math.random() * 6200;
      timerRef.current = setTimeout(() => {
        if (cancelled) return;
        setPeek(true);
        timerRef.current = setTimeout(() => {
          if (cancelled) return;
          setPeek(false);
          schedule();
        }, 900);
      }, wait);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [mood]);

  const art = ART[mood];

  return (
    <section className="pet-stage" data-mood={mood} data-peek={peek ? "1" : "0"} aria-label="桌面宠物">
      <AnimatePresence>
        {caption ? (
          <motion.div
            key={caption + mood}
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

      <div className="pet-figure">
        {/* 三层嵌套：浮动 / 摇摆 / 呼吸，各走各的周期叠在一起，动作才不像机械摆动 */}
        <div className="pet-l-float">
          <div className="pet-l-sway">
            <div className="pet-l-breathe">
              <AnimatePresence mode="sync">
                <motion.img
                  key={mood}
                  className="pet-art"
                  src={art.src}
                  alt=""
                  draggable={false}
                  style={{
                    height: `${art.scale * 100}%`,
                    width: `${art.ratio * art.scale * 100}%`
                  }}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                />
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="pet-shadow" aria-hidden="true" />

        {mood === "success" ? (
          <div className="pet-sparks" aria-hidden="true">
            {Array.from({ length: 7 }).map((_, index) => {
              const angle = (index / 7) * Math.PI * 2 - Math.PI / 2;
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

      <div className="pet-plate">
        <span className="pet-plate-dot" aria-hidden="true" />
        <span className="pet-plate-text">{MOOD_LABEL[mood]}</span>
      </div>
    </section>
  );
}
