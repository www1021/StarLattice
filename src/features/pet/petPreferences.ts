/** 工作宠偏好：是否开启、用哪只小新、用哪套动作。
 *  跟外观设置一样存在本机 localStorage、按登录账号分键，不上传。
 *  功能本身（角色立绘、动画、设置界面）全部随代码分发，任何人 clone 下来都有。 */
import { accountStorage } from "../auth/accountStorage";

const STORAGE_KEY = "sl.pet";

export type PetPreference = {
  /** 是否显示工作宠 */
  enabled: boolean;
  /** 选中的角色 id，见 petCast.ts 的 SELECTABLE_CAST */
  castId: string;
  /** 专属动作包 id，见 petCast.ts 的 MOTIONS */
  motionId: string;
};

export const DEFAULT_PET_PREFERENCE: PetPreference = {
  enabled: true,
  castId: "xiaoxin",
  motionId: "default"
};

export function readPetPreference(): PetPreference {
  try {
    const raw = accountStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PET_PREFERENCE };
    const parsed = JSON.parse(raw) as Partial<PetPreference>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PET_PREFERENCE.enabled,
      castId: typeof parsed.castId === "string" ? parsed.castId : DEFAULT_PET_PREFERENCE.castId,
      motionId: typeof parsed.motionId === "string" ? parsed.motionId : DEFAULT_PET_PREFERENCE.motionId
    };
  } catch {
    return { ...DEFAULT_PET_PREFERENCE };
  }
}

export function persistPetPreference(next: PetPreference): boolean {
  try {
    accountStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
