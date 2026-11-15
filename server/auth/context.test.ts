import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import multer from "multer";
import {
  authFromResponse,
  currentOwnerId,
  resumeAuth,
  runWithAuth,
  type AuthContext
} from "./context.js";

const context: AuthContext = {
  userId: "u-member",
  username: "member",
  displayName: "成员",
  role: "member",
  sessionId: "s-1"
};

test("authFromResponse 只在 locals 里真的放了身份时才返回", () => {
  assert.equal(authFromResponse({ locals: {} }), undefined);
  assert.equal(authFromResponse({ locals: { auth: { userId: "u" } } })?.userId, "u");
  assert.equal(authFromResponse({} as express.Response), undefined);
});

test("resumeAuth 没有身份时照常执行，不吞异常", () => {
  assert.equal(currentOwnerId(), null);
  assert.equal(
    resumeAuth(undefined, () => 42),
    42
  );
  assert.throws(
    () =>
      resumeAuth(undefined, () => {
        throw new Error("boom");
      }),
    /boom/
  );
});

test("resumeAuth 能把身份接回来", () => {
  assert.equal(
    resumeAuth(context, () => currentOwnerId()),
    "u-member"
  );
});

/**
 * 回归用例：multer 的完成回调来自 socket 的 data 事件，那条异步链早于鉴权中间件创建，
 * AsyncLocalStorage 到这里是断的。不接回来，业务代码就会以为「没有账号」，
 * 进而回落到进程级环境变量 —— 没配密钥的账号也能用上部署方那把。
 */
test("multipart 解析完成后仍拿得到账号身份", async () => {
  const app = express();
  app.use("/api", (_request, response, next) => {
    response.locals.auth = context;
    runWithAuth(context, () => next());
  });

  const upload = multer({ storage: multer.memoryStorage() });
  app.post("/api/upload", (request, response) => {
    upload.array("files", 2)(request, response, (error) =>
      resumeAuth(authFromResponse(response), () => {
        response.json({
          owner: currentOwnerId(),
          fileCount: Array.isArray(request.files) ? request.files.length : 0,
          failed: Boolean(error)
        });
      })
    );
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const form = new FormData();
    form.append("messages", JSON.stringify([{ role: "user", content: "1+1等于几" }]));
    form.append("files", new Blob(["abc"], { type: "text/plain" }), "a.txt");

    const payload = (await fetch(`http://127.0.0.1:${port}/api/upload`, {
      method: "POST",
      body: form
    }).then((response) => response.json())) as {
      owner: string | null;
      fileCount: number;
      failed: boolean;
    };

    assert.equal(payload.failed, false);
    assert.equal(payload.fileCount, 1);
    assert.equal(payload.owner, "u-member");
  } finally {
    server.close();
  }
});
