import { useEffect, useId, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  LogOut,
  ScrollText,
  ShieldCheck,
  UserPlus,
  X
} from "lucide-react";
import {
  changePassword,
  deleteAccount,
  invite,
  listEvents,
  MIN_PASSWORD_LENGTH,
  type AuditEntry
} from "./api";
import { useAuth } from "./AuthProvider";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后再试";
}

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const uid = useId();
  const isOwner = auth.user?.role === "owner";
  const [tab, setTab] = useState<"security" | "members" | "audit">("security");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [nextConfirm, setNextConfirm] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<AuditEntry[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab !== "audit" || !isOwner) {
      return;
    }
    void listEvents()
      .then((result) => setEvents(result.events))
      .catch((reason) => setError(messageOf(reason)));
  }, [tab, isOwner]);

  const changeTab = (next: typeof tab) => {
    setTab(next);
    setError("");
    setNotice("");
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (nextPassword.length < MIN_PASSWORD_LENGTH || nextPassword !== nextConfirm) {
      setError(`新密码至少 ${MIN_PASSWORD_LENGTH} 个字符，且两次输入要一致`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await changePassword({ currentPassword, password: nextPassword });
      // 服务端会踢掉全部会话，这里回到登录页重新输一次。
      await auth.refresh();
      onClose();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await invite({ username: newUsername.trim(), password: newPassword });
      setNotice(`账号 ${newUsername.trim()} 已创建，可以用它登录独立工作区`);
      setNewUsername("");
      setNewPassword("");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    setBusy(true);
    setError("");
    try {
      await deleteAccount();
      await auth.refresh();
      onClose();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="auth-modal-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="账号与安全"
      >
        <header className="account-head">
          <div>
            <p className="account-eyebrow">账号与安全</p>
            <h2>{auth.user?.displayName ?? "本地用户"}</h2>
            <p className="account-sub">
              @{auth.user?.username} · {isOwner ? "所有者" : "成员"} · 本机工作区
            </p>
          </div>
          <button type="button" className="account-close" onClick={onClose} aria-label="关闭">
            <X size={18} strokeWidth={1.8} />
          </button>
        </header>

        <nav className="account-tabs" aria-label="账号设置分区">
          <button
            type="button"
            className={tab === "security" ? "is-active" : ""}
            onClick={() => changeTab("security")}
          >
            <KeyRound size={15} strokeWidth={1.8} /> 密码与登录
          </button>
          {isOwner ? (
            <>
              <button
                type="button"
                className={tab === "members" ? "is-active" : ""}
                onClick={() => changeTab("members")}
              >
                <UserPlus size={15} strokeWidth={1.8} /> 添加成员
              </button>
              <button
                type="button"
                className={tab === "audit" ? "is-active" : ""}
                onClick={() => changeTab("audit")}
              >
                <ScrollText size={15} strokeWidth={1.8} /> 操作日志
              </button>
            </>
          ) : null}
        </nav>

        <div className="account-body">
          {error ? (
            <div className="auth-error" role="alert">
              <AlertCircle size={15} strokeWidth={1.8} />
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div className="account-notice" role="status">
              <Check size={15} strokeWidth={1.8} />
              <span>{notice}</span>
            </div>
          ) : null}

          {tab === "security" ? (
            <>
              <form className="account-form" onSubmit={submitPassword}>
                <p className="account-section-title">修改密码</p>
                <p className="account-section-hint">
                  改完后所有设备的登录都会失效，需要重新登录一次。
                </p>
                <div className="auth-field">
                  <label htmlFor={`${uid}-current`}>当前密码</label>
                  <div className="auth-input">
                    <KeyRound size={16} strokeWidth={1.7} />
                    <input
                      id={`${uid}-current`}
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                </div>
                <div className="auth-field">
                  <label htmlFor={`${uid}-next`}>新密码</label>
                  <div className="auth-input">
                    <ShieldCheck size={16} strokeWidth={1.7} />
                    <input
                      id={`${uid}-next`}
                      type="password"
                      autoComplete="new-password"
                      placeholder={`至少 ${MIN_PASSWORD_LENGTH} 个字符`}
                      value={nextPassword}
                      onChange={(event) => setNextPassword(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                </div>
                <div className="auth-field">
                  <label htmlFor={`${uid}-confirm`}>确认新密码</label>
                  <div className="auth-input">
                    <ShieldCheck size={16} strokeWidth={1.7} />
                    <input
                      id={`${uid}-confirm`}
                      type="password"
                      autoComplete="new-password"
                      value={nextConfirm}
                      onChange={(event) => setNextConfirm(event.target.value)}
                      disabled={busy}
                    />
                  </div>
                </div>
                <button className="auth-submit" type="submit" disabled={busy || !currentPassword}>
                  {busy ? <LoaderCircle className="auth-spin" size={16} /> : null}
                  更新密码
                </button>
              </form>

              <div className="account-divider" />

              <div className="account-actions">
                <button type="button" className="account-row" onClick={() => void auth.switchAccount()}>
                  <LogOut size={16} strokeWidth={1.8} />
                  <span>
                    <strong>退出登录 / 切换账号</strong>
                    <small>当前会话立刻失效</small>
                  </span>
                  <ChevronRight size={15} strokeWidth={1.8} />
                </button>
                {!isOwner ? (
                  <div className="account-danger">
                    <p>注销账号会删除这个账号在本机上的全部对话、密钥和导出文件。</p>
                    {confirmDelete ? (
                      <div className="account-danger-actions">
                        <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
                        <button type="button" className="is-danger" onClick={() => void submitDelete()} disabled={busy}>
                          确认注销
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setConfirmDelete(true)}>注销我的账号</button>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {tab === "members" && isOwner ? (
            <form className="account-form" onSubmit={submitInvite}>
              <p className="account-section-title">添加成员账号</p>
              <p className="account-section-hint">
                新成员会有独立的工作区，看不到你的对话、模型密钥和导出文件。对方也可以直接在登录页点「注册」自助创建账号，这里只是代他建一个。
              </p>
              <div className="auth-field">
                <label htmlFor={`${uid}-new-user`}>用户名</label>
                <div className="auth-input">
                  <UserPlus size={16} strokeWidth={1.7} />
                  <input
                    id={`${uid}-new-user`}
                    type="text"
                    autoComplete="off"
                    placeholder="3–32 个字符"
                    value={newUsername}
                    onChange={(event) => setNewUsername(event.target.value)}
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="auth-field">
                <label htmlFor={`${uid}-new-pass`}>初始密码</label>
                <div className="auth-input">
                  <KeyRound size={16} strokeWidth={1.7} />
                  <input
                    id={`${uid}-new-pass`}
                    type="password"
                    autoComplete="new-password"
                    placeholder={`至少 ${MIN_PASSWORD_LENGTH} 个字符`}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    disabled={busy}
                  />
                </div>
              </div>
              <button className="auth-submit" type="submit" disabled={busy || newPassword.length < MIN_PASSWORD_LENGTH}>
                {busy ? <LoaderCircle className="auth-spin" size={16} /> : null}
                创建成员账号
              </button>
            </form>
          ) : null}

          {tab === "audit" && isOwner ? (
            <div className="account-audit">
              <p className="account-section-title">最近操作</p>
              <p className="account-section-hint">
                只记录用户名之外的元数据（动作、对象 id、结果、时间），不记密码、Cookie 或对话正文。
              </p>
              {events.length === 0 ? (
                <p className="account-empty">暂无记录</p>
              ) : (
                <ul>
                  {events.map((event) => (
                    <li key={event.id}>
                      <span className={`account-dot is-${event.result}`} />
                      <span className="account-event-action">{event.action}</span>
                      <span className="account-event-result">{event.result}</span>
                      <time>{event.created_at}</time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
