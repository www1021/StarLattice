import { PlatformError } from "../types.js";
import type {
  PluginInvokeResult,
  PluginListResponse,
  PluginRecord,
  PluginView,
  PluginWrite
} from "../types.js";
import { newPluginId, PluginStore } from "./pluginStore.js";
import { OFFICIAL_PLUGINS } from "./catalog.js";
import { invokePlugin } from "./invoker.js";

function toView(record: PluginRecord): PluginView {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    description: record.description,
    official: record.official,
    status: record.status,
    domain: record.domain,
    runtime: record.runtime,
    endpoint: record.endpoint,
    method: record.method,
    calls: record.calls,
    tools: record.toolCount,
    references: record.references,
    version: record.version,
    updatedAt: record.updatedAt,
    config: record.config
  };
}

const NAME_PATTERN = /^.{1,60}$/;
const METHOD_PATTERN = /^(GET|POST|PUT|DELETE|PATCH)$/i;

/**
 * 插件服务：聚合官方目录（只读）与用户库（可写），对外只吐 PluginView。
 * 官方插件不可改不可删；用户插件的调用计数由这里在每次试跑后累加。
 */
export class PluginService {
  private readonly store: PluginStore;

  constructor(store?: PluginStore) {
    this.store = store ?? new PluginStore();
  }

  list(): PluginListResponse {
    const userPlugins = this.store.list().map(toView);
    const plugins = [...OFFICIAL_PLUGINS, ...userPlugins];
    return {
      plugins,
      total: plugins.length,
      official: OFFICIAL_PLUGINS.length
    };
  }

  get(id: string): PluginView | undefined {
    const official = OFFICIAL_PLUGINS.find((plugin) => plugin.id === id);
    if (official) {
      return official;
    }
    const record = this.store.get(id);
    return record ? toView(record) : undefined;
  }

  /** 启动时播种随代码分发的共享插件；同 id 已存在就跳过，本机改动优先。 */
  seedShared(seeds: PluginRecord[]): number {
    return this.store.seedShared(seeds);
  }

  create(input: PluginWrite): PluginView {
    if (!NAME_PATTERN.test(input.name?.trim() ?? "")) {
      throw new PlatformError("插件名称不能为空，且不超过 60 个字符。", 400);
    }
    if (input.type !== "api" && input.type !== "code") {
      throw new PlatformError("插件类型只能是 api 或 code。", 400);
    }
    if (input.method && !METHOD_PATTERN.test(input.method)) {
      throw new PlatformError("请求方法只支持 GET / POST / PUT / DELETE / PATCH。", 400);
    }

    const id = input.id?.trim() || newPluginId();
    const record = this.store.create({
      id,
      name: input.name.trim(),
      type: input.type,
      description: input.description?.trim() || "（暂无说明）",
      official: false,
      status: input.status ?? "draft",
      domain: input.domain?.trim() || undefined,
      runtime: input.type === "code" ? input.runtime?.trim() || "Python 3.11" : undefined,
      endpoint: input.type === "api" ? input.endpoint?.trim() || undefined : undefined,
      method: input.type === "api" ? (input.method?.toUpperCase() ?? "POST") : undefined,
      calls: 0,
      toolCount: 1,
      references: 0,
      version: "0.1.0",
      config: input.config ?? {}
    });
    return toView(record);
  }

  update(id: string, patch: Partial<PluginWrite>): PluginView {
    if (OFFICIAL_PLUGINS.some((plugin) => plugin.id === id)) {
      throw new PlatformError("官方插件不可修改。", 400);
    }
    if (patch.name !== undefined && !NAME_PATTERN.test(patch.name.trim())) {
      throw new PlatformError("插件名称不能为空，且不超过 60 个字符。", 400);
    }
    if (patch.method && !METHOD_PATTERN.test(patch.method)) {
      throw new PlatformError("请求方法只支持 GET / POST / PUT / DELETE / PATCH。", 400);
    }
    const next: Partial<PluginRecord> = {};
    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.description !== undefined) next.description = patch.description.trim() || "（暂无说明）";
    if (patch.domain !== undefined) next.domain = patch.domain.trim() || undefined;
    if (patch.runtime !== undefined) next.runtime = patch.runtime.trim() || undefined;
    if (patch.endpoint !== undefined) next.endpoint = patch.endpoint.trim() || undefined;
    if (patch.method !== undefined) next.method = patch.method.toUpperCase();
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.type !== undefined) next.type = patch.type;
    if (patch.config !== undefined) {
      const existing = this.store.get(id)?.config ?? {};
      next.config = { ...existing, ...patch.config };
    }
    const record = this.store.update(id, next);
    return toView(record);
  }

  delete(id: string): boolean {
    if (OFFICIAL_PLUGINS.some((plugin) => plugin.id === id)) {
      throw new PlatformError("官方插件不可删除。", 400);
    }
    return this.store.remove(id);
  }

  /**
   * 创建前的验证：用一份临时记录（id="preview"，不落库）跑真实调用，
   * 让前端在「完成创建」之前先确认插件可用。返回调用结果与状态码。
   */
  async preview(input: PluginWrite, args: Record<string, unknown>): Promise<PluginInvokeResult> {
    if (!NAME_PATTERN.test(input.name?.trim() ?? "")) {
      throw new PlatformError("插件名称不能为空，且不超过 60 个字符。", 400);
    }
    if (input.type !== "api" && input.type !== "code") {
      throw new PlatformError("插件类型只能是 api 或 code。", 400);
    }
    if (input.type === "api" && input.method && !METHOD_PATTERN.test(input.method)) {
      throw new PlatformError("请求方法只支持 GET / POST / PUT / DELETE / PATCH。", 400);
    }
    const record: PluginRecord = {
      id: "preview",
      name: input.name.trim(),
      type: input.type,
      description: input.description?.trim() || "",
      official: false,
      status: "draft",
      domain: input.domain?.trim() || undefined,
      runtime: input.type === "code" ? input.runtime?.trim() || "Python 3.11" : undefined,
      endpoint: input.type === "api" ? input.endpoint?.trim() || undefined : undefined,
      method: input.type === "api" ? (input.method?.toUpperCase() ?? "POST") : undefined,
      calls: 0,
      toolCount: 1,
      references: 0,
      version: "0.1.0",
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      config: input.config ?? {}
    };
    return invokePlugin(record, args ?? {});
  }

  /** 试运行：官方插件拒绝；用户插件调真实实现并累加调用计数。 */
  async test(id: string, args: Record<string, unknown>): Promise<PluginInvokeResult> {
    if (OFFICIAL_PLUGINS.some((plugin) => plugin.id === id)) {
      throw new PlatformError("官方插件由平台维护，无需测试。", 400);
    }
    const record = this.store.get(id);
    if (!record) {
      throw new PlatformError("插件不存在。", 404);
    }
    const result = await invokePlugin(record, args ?? {});
    this.store.incrementCalls(id, 1);
    const refreshed = this.store.get(id);
    if (refreshed) {
      return { ...result };
    }
    return result;
  }
}
