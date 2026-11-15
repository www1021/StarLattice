import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  APPEARANCE_STORAGE_KEY,
  currentAccountScope
} from "../features/auth/accountStorage";
import { DEFAULT_APPEARANCE, applyAppearance } from "../features/theme/appearance";

type Props = { children: ReactNode };

type State = {
  error: Error | null;
  /** 重试时递增，用来把子树整个重建一遍。 */
  attempt: number;
};

/**
 * 渲染阶段的最后一道兜底。
 *
 * 之前任何一个页面组件抛错，React 会把整棵树卸载掉，屏幕上只剩背景色，
 * 看起来就是「登录进去一片空白」，控制台里的原因也容易被忽略。
 * 这里把异常接住，显示可读的原因，并给三个出口：重试、重载、清掉界面偏好。
 *
 * 只清外观键（主题 / 背景照片 / 抠图），不动账号、对话和知识库数据。
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[StarLattice] 界面渲染失败：", error, info.componentStack);
  }

  private retry = () => {
    this.setState((previous) => ({ error: null, attempt: previous.attempt + 1 }));
  };

  private reload = () => {
    window.location.reload();
  };

  private clearAppearanceAndReload = () => {
    try {
      const scope = currentAccountScope();
      window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
      if (scope) {
        window.localStorage.removeItem(`sl.account.${scope}.${APPEARANCE_STORAGE_KEY}`);
      }
    } catch {
      // 隐私模式下删不掉也没关系，下面照样把当前页面恢复成无照片外观。
    }
    try {
      applyAppearance(DEFAULT_APPEARANCE);
    } catch {
      // 外观模块本身出错时不再纠缠，直接重载。
    }
    window.location.reload();
  };

  render() {
    const { error, attempt } = this.state;
    if (!error) {
      return <div key={attempt} className="app-boundary">{this.props.children}</div>;
    }

    const message = error.message?.trim() || "未知渲染错误";
    return (
      <div className="app-crash" role="alert">
        <div className="app-crash-card">
          <span className="app-crash-mark" aria-hidden="true">!</span>
          <h1>界面没能加载出来</h1>
          <p>
            页面在渲染时中断了。先点「重试渲染」；如果还是停在这里，多半是本地残留的界面偏好或浏览器里的旧脚本，
            可以清除界面偏好后重新加载。
          </p>
          <pre className="app-crash-message">{message}</pre>
          {error.stack ? (
            <details className="app-crash-detail">
              <summary>技术细节</summary>
              <pre>{error.stack}</pre>
            </details>
          ) : null}
          <div className="app-crash-actions">
            <button type="button" className="is-primary" onClick={this.retry}>
              重试渲染
            </button>
            <button type="button" onClick={this.reload}>
              重新加载页面
            </button>
            <button type="button" className="is-quiet" onClick={this.clearAppearanceAndReload}>
              清除界面偏好并重载
            </button>
          </div>
          <p className="app-crash-foot">
            清除界面偏好只影响主题和背景照片，账号、对话和知识库数据都不会动。
          </p>
        </div>
      </div>
    );
  }
}
