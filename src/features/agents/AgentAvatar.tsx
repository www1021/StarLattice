import defaultRobotAvatar from "../../images/机器人.png";
import "./agents.css";

type AgentAvatarProps = {
  name: string;
  avatar?: string;
  size?: number;
  className?: string;
};

/**
 * 有头像就显示图，没有就用统一的机器人图。
 *
 * 不再用名字首字兜底：聊天页一排智能体时，纯色方块比机器人图标更难认，
 * 而且「没传头像」和「传了一张纯色图」在小尺寸下几乎分不出来。
 */
export function AgentAvatar({ name, avatar, size = 36, className = "" }: AgentAvatarProps) {
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.32) };
  return (
    <img
      className={`agent-avatar ${className}`}
      style={style}
      src={avatar || defaultRobotAvatar}
      alt={name}
      draggable={false}
    />
  );
}
