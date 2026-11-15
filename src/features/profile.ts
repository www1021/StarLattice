/**
 * 界面上显示的身份。以前是写死的常量，现在由登录后的账号显示名填入。
 * 导出用 let 是让 ESM 的 live binding 生效：问候语这类只读一次的地方
 * 不必改成 hook，也能跟着账号切换。
 */

export let USER_DISPLAY_NAME = "本地用户";
export let USER_AVATAR_TEXT = "本";

export function setCurrentProfile(displayName: string): void {
  const name = displayName.trim().slice(0, 32) || "本地用户";
  USER_DISPLAY_NAME = name;
  USER_AVATAR_TEXT = Array.from(name)[0] ?? "本";
}
