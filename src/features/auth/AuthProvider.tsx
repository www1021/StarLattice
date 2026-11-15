import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import {
  fetchSession,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
  type AuthUser,
  type SessionInfo
} from "./api";
import { setCurrentProfile } from "../profile";
import { applyAppearance, readAppearance } from "../theme/appearance";
import { setAccountScope } from "./accountStorage";
import { LoginPage } from "./LoginPage";

type AuthStatus = "loading" | "guest" | "authed";

type AuthValue = {
  status: AuthStatus;
  user: AuthUser | null;
  hasUsers: boolean;
  signupOpen: boolean;
  /** 会话过期时记下当前位置，登录后能回到原来的界面。 */
  returnPath: string;
  refresh: () => Promise<void>;
  login: (input: { username: string; password: string; remember: boolean }) => Promise<void>;
  register: (input: { username: string; password: string; displayName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchAccount: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth 必须在 AuthProvider 内使用");
  }
  return value;
}

/**
 * 全局拦一层 fetch：给所有请求带同源标记，并把业务接口的 401 收敛成
 * 一个事件。项目里有三套 api.ts，加上 SSE、下载和很多直接 fetch 的调用点，
 * 逐个加判断容易漏，这里统一收口最稳。
 */
let fetchPatched = false;
function installFetchInterceptor() {
  if (fetchPatched || typeof window === "undefined") {
    return;
  }
  fetchPatched = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set("X-Requested-With", "StarLattice");
    const response = await nativeFetch(input, { ...init, headers });
    if (response.status === 401) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      if (!url.includes("/api/auth/")) {
        window.dispatchEvent(new CustomEvent("sl:unauthorized"));
      }
    }
    return response;
  };
}

installFetchInterceptor();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    status: AuthStatus;
    session: SessionInfo | null;
    returnPath: string;
  }>({ status: "loading", session: null, returnPath: "" });

  /**
   * 把会话落到状态里之前，先切好本地存储作用域和界面显示名。
   * 这两件事必须在 children 首次渲染前完成（各页面用 useState 读本地键），
   * 但放在 render 里做属于渲染期副作用，StrictMode 下会重复执行、也容易被
   * React 丢弃的渲染带偏。放在 setState 之前同步执行，顺序一样稳。
   */
  const applySession = useCallback((session: SessionInfo) => {
    const user = session.authenticated ? session.user : null;
    setAccountScope(user?.id ?? null);
    if (user) {
      setCurrentProfile(user.displayName);
    }
    setState({
      status: user ? "authed" : "guest",
      session,
      returnPath: ""
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySession(await fetchSession());
    } catch {
      applySession({
        authenticated: false,
        user: null,
        hasUsers: true,
        signupOpen: false
      });
    }
  }, [applySession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const appearance = readAppearance();
    // 登录页是公共界面，不展示任何账号上传的背景照片或抠图；
    // 账号切换后这里和 App 的外观 effect 会各自把偏好重新应用一遍。
    applyAppearance(
      state.status === "authed"
        ? appearance
        : { ...appearance, photo: null, cutout: null }
    );
  }, [state.status, state.session?.user?.id]);

  useEffect(() => {
    const onUnauthorized = () => {
      // 会话失效后立刻离开账号作用域，避免登录页或下一个账号读到旧键。
      setAccountScope(null);
      setState((previous) => ({
        status: "guest",
        session: previous.session
          ? { ...previous.session, authenticated: false, user: null }
          : null,
        returnPath: `${window.location.pathname}${window.location.hash}${window.location.search}`
      }));
    };
    window.addEventListener("sl:unauthorized", onUnauthorized);
    return () => window.removeEventListener("sl:unauthorized", onUnauthorized);
  }, []);

  const login = useCallback<AuthValue["login"]>(async (input) => {
    await loginRequest(input);
    await refresh();
  }, [refresh]);

  const register = useCallback<AuthValue["register"]>(async (input) => {
    await registerRequest(input);
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      await refresh();
    }
  }, [refresh]);

  const switchAccount = useCallback(async () => {
    await logout();
  }, [logout]);

  const value = useMemo<AuthValue>(
    () => ({
      status: state.status,
      user: state.session?.user ?? null,
      hasUsers: state.session?.hasUsers ?? false,
      signupOpen: state.session?.signupOpen ?? false,
      returnPath: state.returnPath,
      refresh,
      login,
      register,
      logout,
      switchAccount
    }),
    [state, refresh, login, register, logout, switchAccount]
  );

  return (
    <AuthContext.Provider value={value}>
      {state.status === "loading" ? (
        <div className="auth-boot" role="status" aria-live="polite">
          <span className="auth-boot-mark" />
          <span>正在检查本地工作区</span>
        </div>
      ) : state.status === "authed" ? (
        // 换账号就重建整棵子树：外观、场景、模型选择、课堂快照这些 useState
        // 初值都是挂载时从本地键读的，不重建会把上一个账号的状态写进新账号。
        <Fragment key={state.session?.user?.id}>{children}</Fragment>
      ) : (
        <LoginPage />
      )}
    </AuthContext.Provider>
  );
}
