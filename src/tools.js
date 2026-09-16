// 原工具实现完整保存在 tools-core.js。
// 本文件只提供“实验工具调度器”的薄包装：关闭时直接委托原实现，保持现有行为。
import { getConfig } from './config.js';
import {
  annotateExperimentalToolSchemas,
  experimentalBatchKey,
  experimentalToolSchedulerConfig,
  ExperimentalToolBatch
} from './experimental-tool-scheduler.js';
import {
  buildToolDefs as coreBuildToolDefs,
  executeTool as coreExecuteTool,
  toOpenAiTools as coreToOpenAiTools
} from './tools-core.js';

export * from './tools-core.js';

// 显式导出覆盖 export * 中同名项；关闭实验时仍原样调用旧实现。
export const buildToolDefs = coreBuildToolDefs;

export function toOpenAiTools(defs) {
  const tools = coreToOpenAiTools(defs);
  return annotateExperimentalToolSchemas(tools, getConfig());
}

const batchBySession = new WeakMap();

function latestAssistantToolCalls(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length
    ) return message.tool_calls;
  }
  return [];
}

function schedulerMetrics(session, batch, settings) {
  if (!session || !batch) return;
  session.experimentalToolScheduler = {
    enabled: true,
    maxParallelReads: settings.maxParallelReads,
    ...batch.metrics()
  };
}

function runtimeBatch(defs, ctx, settings) {
  const session = ctx?.session;
  if (!session || typeof session !== 'object') return null;
  const calls = latestAssistantToolCalls(session);
  if (!calls.length) return null;
  const key = experimentalBatchKey(calls, session.rounds);
  const old = batchBySession.get(session);
  if (old?.key === key) return old.batch;

  const batch = new ExperimentalToolBatch(calls, {
    maxParallelReads: settings.maxParallelReads,
    execute: (call) => coreExecuteTool(
      defs,
      ctx,
      call?.function?.name ?? '',
      call?.function?.arguments ?? '{}'
    ),
    onParallelWave: ({ size, names }) => {
      session.experimentalToolScheduler = {
        enabled: true,
        maxParallelReads: settings.maxParallelReads,
        parallelWaveActive: true,
        lastParallelSize: size,
        lastParallelTools: names
      };
    }
  });
  batchBySession.set(session, { key, batch });
  schedulerMetrics(session, batch, settings);
  return batch;
}

/**
 * 实验关闭：直接进入旧 executeTool，连批次解析都不做。
 * 实验开启：宿主依旧逐个 await 本函数；仅连续只读工具会被后台并行预启动。
 */
export async function executeTool(defs, ctx, name, argsJson) {
  const settings = experimentalToolSchedulerConfig(getConfig());
  if (!settings.enabled) {
    return coreExecuteTool(defs, ctx, name, argsJson);
  }

  const batch = runtimeBatch(defs, ctx, settings);
  if (!batch) return coreExecuteTool(defs, ctx, name, argsJson);

  const scheduled = await batch.next(name, argsJson);
  if (!scheduled.handled) {
    // Session 审计结构与宿主调用顺序出现任何不一致时，宁可退回旧串行路径。
    return coreExecuteTool(defs, ctx, name, argsJson);
  }
  schedulerMetrics(ctx?.session, batch, settings);
  return scheduled.result;
}
