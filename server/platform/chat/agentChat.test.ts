import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import { runWithAuth, type AuthContext } from "../../auth/context.js";
import {
  applyVariables,
  buildAgentChatSystemPrompt,
  contextTurnsOf,
  parseAvatar,
  parseChatConfig,
  trimMessagesByTurns
} from "./agentChat.js";
import type { AgentRecord, AgentWrite } from "../types.js";

function contextOf(userId: string): AuthContext {
  return { userId, username: userId, displayName: userId, role: "member", sessionId: "s" };
}

function ownerContextOf(userId: string): AuthContext {
  return { userId, username: userId, displayName: userId, role: "owner", sessionId: "s" };
}

function withStore(run: (store: PlatformStateStore) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-chat-agents-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    store.seedAgents(BUILTIN_AGENTS);
    run(store);
  } finally {
    store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

function agentWrite(overrides: Partial<AgentWrite> = {}): AgentWrite {
  return {
    id: `chat-test-${Math.random().toString(36).slice(2, 8)}`,
    name: "数学教案打磨",
    version: 1,
    role: "初中数学教研员",
    prompt: "用户要讲《{{课题}}》。",
    tools: [],
    model: "platform-default",
    capabilities: [],
    memory: {},
    enabled: true,
    description: "把知识点拆成台阶",
    avatar: "",
    chatConfig: { contextTurns: 3 },
    ...overrides
  };
}

test("自建智能体只对本人可见，工作流引用与聊天都能取到", () => {
  withStore((store) => {
    const created = runWithAuth(contextOf("u-owner"), () =>
      store.saveAgent(agentWrite())
    );

    runWithAuth(contextOf("u-owner"), () => {
      const mine = store.listChatAgents();
      assert.ok(mine.some((agent) => agent.id === created.id));
      // 工作流挑人走 listAgents，自建必须也在里面，否则引用不到。
      assert.ok(store.listAgents().some((agent) => agent.id === created.id));
      assert.equal(store.getAgent(created.id)?.source, "custom");
      // 内置那批仍在，两类混在一份清单里
      assert.ok(store.listAgents().some((agent) => agent.source === "builtin"));
    });

    runWithAuth(contextOf("u-other"), () => {
      assert.equal(store.listChatAgents().length, 0);
      assert.equal(store.getAgent(created.id), undefined);
    });
  });
});

test("播种的共享智能体对全员可见，部署者可改且保持共享，成员只读", () => {
  withStore((store) => {
    const seed = {
      id: "ytz-guide",
      name: "研途引航",
      description: "共享示例",
      role: "总调度",
      prompt: "你是研途引航。",
      model: "platform-default",
      tools: [],
      enabled: true
    };
    store.seedSharedChatAgents([seed]);

    runWithAuth(contextOf("u-a"), () => {
      assert.ok(store.listChatAgents().some((agent) => agent.id === "ytz-guide"));
    });
    runWithAuth(contextOf("u-b"), () => {
      assert.ok(store.listChatAgents().some((agent) => agent.id === "ytz-guide"));
    });

    // 成员改共享智能体被拒绝。
    runWithAuth(contextOf("u-a"), () => {
      assert.throws(
        () => store.saveAgent({ ...seed, name: "研途引航·改", version: 2, capabilities: [], memory: {} }),
        /只读/
      );
    });
    // 部署者改完仍是共享（无主），所有人都能看到新名字。
    runWithAuth(ownerContextOf("deployer"), () => {
      const saved = store.saveAgent({
        ...seed,
        name: "研途引航·改",
        version: 2,
        capabilities: [],
        memory: {}
      });
      assert.equal(saved.name, "研途引航·改");
    });
    store.seedSharedChatAgents([seed]);
    runWithAuth(contextOf("u-b"), () => {
      assert.equal(
        store.listChatAgents().find((agent) => agent.id === "ytz-guide")?.name,
        "研途引航·改"
      );
    });
  });
});

test("共享智能体版本提高时同步提示词与工具绑定，不改本地展示字段", () => {
  withStore((store) => {
    const seed = {
      id: "ytz-guide",
      name: "研途引航",
      description: "共享示例",
      role: "科研导师",
      prompt: "旧提示词",
      model: "platform-default",
      tools: [] as string[],
      enabled: true,
      version: 2
    };
    store.seedSharedChatAgents([seed]);

    // 代码里升到 v5：旧库必须跟着换提示词和转交工具，否则新逻辑永远跑在旧配置上。
    store.seedSharedChatAgents([
      { ...seed, prompt: "新提示词", tools: ["agent://ytz-literature"], version: 5 }
    ]);

    const agent = store.getAgent("ytz-guide");
    assert.equal(agent?.version, 5);
    assert.equal(agent?.prompt, "新提示词");
    assert.deepEqual(agent?.tools, ["agent://ytz-literature"]);
    assert.equal(agent?.name, "研途引航");
  });
});

test("系统提示词：有工具必须先调用，没工具不许编文献也不能假装启动子 Agent", () => {
  const agent = {
    id: "test-agent",
    name: "测试智能体",
    role: "文献导师",
    description: "",
    prompt: "回答问题。",
    tools: [],
    model: "platform-default"
  } as unknown as AgentRecord;

  const withTools = buildAgentChatSystemPrompt(agent, { toolNames: ["文献检索（OpenAlex）"] });
  assert.match(withTools, /必须先调用合适的工具/);
  assert.match(withTools, /本轮可调用的工具：文献检索/);
  assert.match(withTools, /工具结果是外部事实的唯一来源/);

  const withoutTools = buildAgentChatSystemPrompt(agent);
  assert.match(withoutTools, /不要编造具体的论文条目/);
  assert.match(withoutTools, /不要声称「已为你启动/);
  assert.match(withoutTools, /建议用户切换到挂有相应工具的专项智能体/);
  assert.doesNotMatch(withoutTools, /本轮可调用的工具/);

  // 有转交工具时，协议从「建议用户切换」改成「真的转过去」。
  const withDelegation = buildAgentChatSystemPrompt(agent, {
    toolNames: ["转交给文献阅读Agent"],
    delegationTargets: ["文献阅读Agent"]
  });
  assert.match(withDelegation, /本轮可以转交的专项智能体：文献阅读Agent/);
  assert.match(withDelegation, /转交是真实执行/);
  assert.match(withDelegation, /先调用转交工具把问题交给对应专项智能体/);
  assert.doesNotMatch(withDelegation, /建议用户切换到挂有相应工具的专项智能体/);
});

test("内置 Agent 只读，自建的可以改也可以删", () => {
  withStore((store) => {
    const builtin = BUILTIN_AGENTS[0];
    runWithAuth(contextOf("u-owner"), () => {
      assert.throws(
        () => store.saveAgent(agentWrite({ id: builtin.id, name: "改个名" })),
        /只读/
      );
    });

    const created = runWithAuth(contextOf("u-owner"), () =>
      store.saveAgent(agentWrite())
    );
    runWithAuth(contextOf("u-owner"), () => {
      const updated = store.saveAgent({
        ...agentWrite({ id: created.id }),
        name: "改名后的智能体",
        version: 2
      });
      assert.equal(updated.name, "改名后的智能体");
      assert.equal(store.deleteAgent(created.id), true);
      assert.equal(store.getAgent(created.id), undefined);
    });
  });
});

test("别人的自建智能体改不动，按不存在处理", () => {
  withStore((store) => {
    const created = runWithAuth(contextOf("u-owner"), () =>
      store.saveAgent(agentWrite())
    );
    runWithAuth(contextOf("u-other"), () => {
      assert.throws(
        () => store.saveAgent({ ...agentWrite({ id: created.id }), name: "偷改" }),
        /不存在/
      );
      // 删别人的也按「不存在」处理，不泄露它到底存不存在
      assert.throws(() => store.deleteAgent(created.id), /不存在/);
    });
  });
});

test("只保留最近 N 轮，从倒数第 N 条用户消息开始截", () => {
  const messages = [
    { role: "user", content: "第1问" },
    { role: "assistant", content: "第1答" },
    { role: "user", content: "第2问" },
    { role: "assistant", content: "第2答" },
    { role: "user", content: "第3问" },
    { role: "assistant", content: "第3答" },
    { role: "user", content: "第4问" }
  ];

  assert.deepEqual(
    trimMessagesByTurns(messages, 2).map((message) => message.content),
    ["第3问", "第3答", "第4问"]
  );
  // 轮数够大就原样返回，不做无谓的复制
  assert.equal(trimMessagesByTurns(messages, 10).length, messages.length);
});

test("变量替换支持中文名，没填的保留占位符", () => {
  assert.equal(
    applyVariables("讲《{{课题}}》，面向{{学段}}，{{缺的}}留空", {
      课题: "勾股定理",
      学段: "初二"
    }),
    "讲《勾股定理》，面向初二，{{缺的}}留空"
  );
});

test("系统提示词带上角色、变量与记忆，且基线不可被覆盖", () => {
  const agent = {
    id: "a",
    name: "助手",
    version: 1,
    role: "初中数学教研员",
    prompt: "讲课要拆成台阶，课题是{{课题}}。",
    tools: [],
    model: "m",
    capabilities: [],
    memory: {},
    enabled: true,
    createdAt: "",
    updatedAt: ""
  } satisfies AgentRecord;

  const system = buildAgentChatSystemPrompt(agent, {
    variables: { 课题: "勾股定理" },
    memories: ["上次讲到勾股定理时学生卡在逆定理"]
  });

  assert.match(system, /不要编造事实/);
  assert.match(system, /初中数学教研员/);
  assert.match(system, /课题是勾股定理/);
  assert.match(system, /课题=勾股定理/);
  assert.match(system, /卡在逆定理/);
  assert.doesNotMatch(system, /\{\{课题\}\}/);
});

test("对话配置：轮数收在 1～30，中文变量名放行，非法值报 400", () => {
  assert.equal(parseChatConfig({ contextTurns: 99 }).contextTurns, 30);
  // 0 这类越界值被拉到下限，不会变成「不裁剪」
  assert.equal(parseChatConfig({ contextTurns: 0 }).contextTurns, 1);
  assert.throws(() => parseChatConfig({ contextTurns: "很多" }), /1 到 30/);
  assert.throws(() => parseChatConfig({ variables: [{ key: "1abc" }] }), /变量名/);
  assert.equal(
    parseChatConfig({ variables: [{ key: "课题", label: "课题" }] }).variables?.[0].key,
    "课题"
  );
  assert.equal(parseChatConfig({ typewriter: false }).typewriter, false);
  // 没配轮数时按默认 6 轮走
  assert.equal(contextTurnsOf(undefined), 6);
});

test("头像只收图片 data URL，超长直接拒绝", () => {
  assert.equal(parseAvatar(""), "");
  assert.throws(() => parseAvatar("https://example.com/a.png"), /格式不支持/);
  assert.throws(() => parseAvatar("data:text/plain;base64,AAAA"), /格式不支持/);
  assert.equal(
    parseAvatar("data:image/png;base64,iVBORw0KGgo="),
    "data:image/png;base64,iVBORw0KGgo="
  );
  assert.throws(() => parseAvatar(`data:image/png;base64,${"A".repeat(200_001)}`), /太大/);
});
