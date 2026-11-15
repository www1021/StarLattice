import { useEffect, useId, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Database,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UserRound
} from "lucide-react";
import { useAuth } from "./AuthProvider";
import { MIN_PASSWORD_LENGTH } from "./api";

type Mode = "login" | "register";

const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{3,32}$/u;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后再试";
}

export function LoginPage() {
  const {
    hasUsers,
    signupOpen,
    returnPath,
    login,
    register
  } = useAuth();
  const [mode, setMode] = useState<Mode>(hasUsers ? "login" : "register");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const uid = useId();

  useEffect(() => {
    setMode(hasUsers ? "login" : "register");
    setError("");
  }, [hasUsers]);

  const isRegister = mode === "register";
  const usernameValid = USERNAME_PATTERN.test(username.trim());
  // 登录时不套注册的长度规则，老账号用更短的密码也能登进来。
  const passwordValid = isRegister
    ? password.length >= MIN_PASSWORD_LENGTH
    : password.length > 0;
  const confirmValid = !isRegister || confirm === password;
  // 默认谁都能注册。只有显式关掉公开注册时（AUTH_ALLOW_SIGNUP=0），
  // 注册表单才只作说明，不让人白提交一次。
  const signupClosed = isRegister && hasUsers && !signupOpen;
  const canSubmit =
    usernameValid && passwordValid && confirmValid && !busy && !signupClosed;

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setTouched(false);
    setConfirm("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (isRegister) {
        await register({
          username: username.trim(),
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {})
        });
      } else {
        await login({ username: username.trim(), password, remember });
      }
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-page-photo" aria-hidden="true" />
      <div className="auth-page-inner">
        <section className="auth-brand" aria-label="产品说明">
          <div className="auth-brand-top">
            <span className="auth-brand-mark" aria-hidden="true">
              <Layers3 size={22} strokeWidth={1.7} />
            </span>
            <span className="auth-brand-name">StarLattice</span>
          </div>
          <div className="auth-brand-copy">
            <p className="auth-eyebrow">本地优先的 Agent 工作区</p>
            <h1>把对话、工作流和知识<br />留在你自己的机器上</h1>
            <p className="auth-brand-lead">
              账号只用来区分这台机器上的工作区。所有内容存在本地，不上传云端。
            </p>
          </div>
          <ul className="auth-points">
            <li>
              <ShieldCheck size={17} strokeWidth={1.7} />
              <span>
                <strong>密码不落明文</strong>
                <small>scrypt 慢哈希加盐存储，服务端也无法还原</small>
              </span>
            </li>
            <li>
              <Database size={17} strokeWidth={1.7} />
              <span>
                <strong>数据按账号隔开</strong>
                <small>对话、密钥、工作流、导出文件各自独立</small>
              </span>
            </li>
            <li>
              <Fingerprint size={17} strokeWidth={1.7} />
              <span>
                <strong>会话可随时收回</strong>
                <small>退出后旧票据立刻失效，操作留痕可查</small>
              </span>
            </li>
          </ul>
          <p className="auth-brand-foot">
            <Sparkles size={13} strokeWidth={1.8} />
            {hasUsers
              ? "账号只是进工作区的钥匙，各自的对话、密钥和文件互不相通"
              : "首次使用会创建一个所有者账号，已有的工作区数据会归入它"}
          </p>
        </section>

        <section className="auth-panel" aria-label="账号">
          <div className="auth-card">
            <div className="auth-tabs" role="tablist" aria-label="登录或注册">
              <button
                type="button"
                role="tab"
                aria-selected={!isRegister}
                className={!isRegister ? "is-active" : ""}
                onClick={() => switchMode("login")}
              >
                登录
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isRegister}
                className={isRegister ? "is-active" : ""}
                onClick={() => switchMode("register")}
              >
                注册
              </button>
            </div>

            <div className="auth-card-head">
              <span className="auth-card-icon" aria-hidden="true">
                {isRegister ? <KeyRound size={20} strokeWidth={1.7} /> : <LockKeyhole size={20} strokeWidth={1.7} />}
              </span>
              <h2>{isRegister ? (hasUsers ? "创建账号" : "创建所有者账号") : "欢迎回来"}</h2>
              <p>
                {isRegister
                  ? hasUsers
                    ? "新账号会有独立的工作区，看不到其他账号的内容"
                    : "这是这台机器上的第一个账号，之前的数据会自动归到它名下"
                  : "登录后进入你的工作区"}
              </p>
            </div>

            {returnPath ? (
              <div className="auth-notice" role="status">
                <AlertCircle size={14} strokeWidth={1.8} />
                登录状态已失效，请重新登录
              </div>
            ) : null}

            {!hasUsers && !isRegister ? (
              <div className="auth-notice is-wrap" role="status">
                <AlertCircle size={14} strokeWidth={1.8} />
                这台机器还没有账号，先切到「注册」创建所有者账号
              </div>
            ) : null}

            {signupClosed ? (
              <div className="auth-notice is-wrap" role="status">
                <AlertCircle size={14} strokeWidth={1.8} />
                这台机器已关闭公开注册。需要账号的话，请让已有账号在「账号与安全 → 添加成员」里创建
              </div>
            ) : null}

            <form className="auth-form" onSubmit={submit} noValidate>
              <div className="auth-field">
                <label htmlFor={`${uid}-user`}>用户名</label>
                <div className="auth-input">
                  <UserRound size={16} strokeWidth={1.7} aria-hidden="true" />
                  <input
                    id={`${uid}-user`}
                    name="username"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder="3–32 个字符，支持中文"
                    value={username}
                    aria-invalid={touched && !usernameValid}
                    aria-describedby={`${uid}-user-hint`}
                    onChange={(event) => setUsername(event.target.value)}
                    onBlur={() => setTouched(true)}
                    disabled={busy}
                  />
                </div>
                <p id={`${uid}-user-hint`} className="auth-field-hint">
                  {touched && username.length > 0 && !usernameValid
                    ? "请使用 3–32 个字母、数字、下划线或中划线"
                    : "用于登录，不收集真实姓名或联系方式"}
                </p>
              </div>

              {isRegister ? (
                <div className="auth-field">
                  <label htmlFor={`${uid}-display`}>
                    显示名称 <em>选填</em>
                  </label>
                  <div className="auth-input">
                    <Sparkles size={16} strokeWidth={1.7} aria-hidden="true" />
                    <input
                      id={`${uid}-display`}
                      name="displayName"
                      type="text"
                      placeholder="留空则与用户名相同"
                      maxLength={32}
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                </div>
              ) : null}

              <div className="auth-field">
                <label htmlFor={`${uid}-pass`}>密码</label>
                <div className="auth-input">
                  <LockKeyhole size={16} strokeWidth={1.7} aria-hidden="true" />
                  <input
                    id={`${uid}-pass`}
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete={isRegister ? "new-password" : "current-password"}
                    placeholder={isRegister ? `至少 ${MIN_PASSWORD_LENGTH} 个字符` : "输入密码"}
                    value={password}
                    aria-invalid={touched && !passwordValid}
                    aria-describedby={`${uid}-pass-hint`}
                    onChange={(event) => setPassword(event.target.value)}
                    onBlur={() => setTouched(true)}
                    disabled={busy}
                  />
                  <button
                    className="auth-reveal"
                    type="button"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((value) => !value)}
                    tabIndex={0}
                  >
                    {showPassword ? <EyeOff size={16} strokeWidth={1.7} /> : <Eye size={16} strokeWidth={1.7} />}
                  </button>
                </div>
                <p id={`${uid}-pass-hint`} className="auth-field-hint">
                  {isRegister
                    ? `至少 ${MIN_PASSWORD_LENGTH} 个字符，不强制符号组合`
                    : "忘记密码暂不能自助找回"}
                </p>
              </div>

              {isRegister ? (
                <div className="auth-field">
                  <label htmlFor={`${uid}-confirm`}>确认密码</label>
                  <div className="auth-input">
                    <ShieldCheck size={16} strokeWidth={1.7} aria-hidden="true" />
                    <input
                      id={`${uid}-confirm`}
                      name="confirm"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="再输入一次"
                      value={confirm}
                      aria-invalid={touched && !confirmValid}
                      onChange={(event) => setConfirm(event.target.value)}
                      onBlur={() => setTouched(true)}
                      disabled={busy}
                    />
                  </div>
                  {touched && !confirmValid ? (
                    <p className="auth-field-hint is-error">两次输入的密码不一致</p>
                  ) : null}
                </div>
              ) : (
                <label className="auth-remember">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                    disabled={busy}
                  />
                  <span>在这台设备上保持登录（7 天）</span>
                </label>
              )}

              {error ? (
                <div className="auth-error" role="alert">
                  <AlertCircle size={15} strokeWidth={1.8} />
                  <span>{error}</span>
                </div>
              ) : null}

              <button className="auth-submit" type="submit" disabled={!canSubmit}>
                {busy ? (
                  <LoaderCircle className="auth-spin" size={17} strokeWidth={2} />
                ) : null}
                <span>
                  {signupClosed
                    ? "公开注册已关闭"
                    : isRegister
                      ? "创建账号并进入"
                      : "登录工作区"}
                </span>
                {!busy ? <ArrowRight size={17} strokeWidth={1.9} /> : null}
              </button>
            </form>

            <p className="auth-legal">
              数据仅保存在本机，账号信息不会发送到外部服务
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
