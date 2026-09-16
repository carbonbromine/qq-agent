// 实验功能：依赖感知工具调度。
//
// 目标：
// - 关闭时由 orchestrator 完全走旧串行路径，本模块不参与执行。
// - 开启时只并行明确标记为只读、互不依赖的工具；写入/发送仍严格串行。
// - finish 是 terminal barrier：前置工具失败时不提交 finish；finish 之后不再产生副作用。

export const EXPERIMENTAL_READ_ONLY_TOOLS = new Set([
  'get_recent_messages',
  'get_message_detail',
  'get_active_members',
  'memory_query',
  'person_memory_lookup',
  'web_search',
  'web_fetch'
]);

const TERMINAL_TOOL = 'finish';
const SAME_ROUND_ACTION_TOOLS = new Set([
  'send_message',
  'send_sticker',
  'send_poke',
  'memory_append',
  'memory_remove',
  'collect_sticker',
  'sticker_note',
  'report_feedback',
  'friend_request_propose'
]);

export function experimentalToolSchedulerConfig(cfg = {}) {
  const raw = cfg?.toolSchedulerPilot || {};
  return {
    enabled: raw.enabled === true,
    maxParallelReads: Math.min(8, Math.max(2, Number(raw.maxParallelReads) || 4))
  };
}

export function experimentalToolSchedulerEnabled(cfg = {}) {
  return experimentalToolSchedulerConfig(cfg).enabled;
}

export function experimentalToolEffect(name) {
  const tool = String(name || '');
  if (tool === TERMINAL_TOOL) return 'terminal';
  if (EXPERIMENTAL_READ_ONLY_TOOLS.has(tool)) return 'read';
  return 'ordered';
}

export function annotateExperimentalToolSchemas(tools, cfg = {}) {
  if (!experimentalToolSchedulerEnabled(cfg)) return tools;
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const next = structuredClone(tool);
    const fn = next?.function;
    const name = String(fn?.name || '');
    if (!fn) return next;
    if (name === TERMINAL_TOOL) {
      fn.description = `${fn.description || ''} 【实验调度】如果本轮动作已经确定，且无需先读取工具结果再决定，可以在同一轮把 finish 作为最后一个工具一起调用；系统只会在前置工具全部成功后提交 finish。`;
    } else if (EXPERIMENTAL_READ_ONLY_TOOLS.has(name)) {
      fn.description = `${fn.description || ''} 【实验调度】与其他互不依赖的只读工具可以在同一轮一起调用，宿主可能并行执行。`;
    } else if (SAME_ROUND_ACTION_TOOLS.has(name)) {
      fn.description = `${fn.description || ''} 【实验调度】如果这个动作就是本轮最后一步且无需观察结果再决策，可同轮再调用 finish，并把 finish 放在最后。`;
    }
    return next;
  });
}

function skippedResult(message, errorCode) {
  return {
    content: `错误：${message}`,
    isError: true,
    errorCode,
    reportIncident: false,
    experimentalSkipped: true
  };
}

async function executeReadWave(calls, { execute, maxParallelReads, signal, canContinue }) {
  const results = new Array(calls.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < calls.length) {
      signal?.throwIfAborted?.();
      if (canContinue && !canContinue()) throw new Error('Run cancelled');
      const index = cursor++;
      results[index] = await execute(calls[index]);
    }
  };
  const count = Math.min(maxParallelReads, calls.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

/**
 * 执行一轮模型产生的 tool_calls。
 *
 * execute(call): 真正执行工具，返回 executeTool 的 result。
 * consume(call, result): 立即把结果写入 Session / provider messages，并执行宿主安全检查。
 * beforeWave(info): 仅用于 UI activity，不参与语义。
 *
 * 返回 { finished, parallelWaves, parallelCalls }。
 */
export async function executeExperimentalToolCalls(calls, {
  execute,
  consume,
  beforeWave = null,
  signal = null,
  canContinue = null,
  maxParallelReads = 4
} = {}) {
  if (typeof execute !== 'function' || typeof consume !== 'function') {
    throw new TypeError('experimental scheduler requires execute and consume callbacks');
  }
  const queue = Array.isArray(calls) ? calls : [];
  const parallelLimit = Math.min(8, Math.max(2, Number(maxParallelReads) || 4));
  let index = 0;
  let priorFailure = false;
  let finished = false;
  let parallelWaves = 0;
  let parallelCalls = 0;

  const assertRunnable = () => {
    signal?.throwIfAborted?.();
    if (canContinue && !canContinue()) throw new Error('Run cancelled');
  };

  while (index < queue.length) {
    assertRunnable();
    const call = queue[index];
    const name = String(call?.function?.name || '');
    const effect = experimentalToolEffect(name);

    if (effect === 'read') {
      const wave = [];
      while (index < queue.length) {
        const candidate = queue[index];
        if (experimentalToolEffect(candidate?.function?.name) !== 'read') break;
        wave.push(candidate);
        index += 1;
      }
      beforeWave?.({ type: 'parallel-read', calls: wave });
      const waveResults = await executeReadWave(wave, {
        execute,
        maxParallelReads: parallelLimit,
        signal,
        canContinue
      });
      if (wave.length > 1) {
        parallelWaves += 1;
        parallelCalls += wave.length;
      }
      // 并发执行、按原始顺序消费，保证 Session/tool result 顺序稳定。
      for (let i = 0; i < wave.length; i += 1) {
        await consume(wave[i], waveResults[i]);
        priorFailure ||= waveResults[i]?.isError === true;
      }
      continue;
    }

    if (effect === 'terminal') {
      beforeWave?.({ type: 'terminal', calls: [call] });
      let result;
      if (priorFailure) {
        result = skippedResult(
          'finish 未执行：本轮前置工具有失败项，需要先让模型看到错误并重新决定。',
          'FINISH_BARRIER_BLOCKED'
        );
      } else {
        result = await execute(call);
      }
      await consume(call, result);
      finished = result?.isError !== true;
      index += 1;

      // finish 无论成功还是被 barrier 阻止，都成为本轮终止边界。
      // 为剩余 tool_call 生成协议完整的结果，但绝不执行其副作用。
      while (index < queue.length) {
        const trailing = queue[index++];
        await consume(trailing, skippedResult(
          finished
            ? '未执行：finish 已结束本轮，终止工具之后不能再执行其他动作。'
            : '未执行：finish 是本轮终止边界；请在下一轮根据前置错误重新决定。',
          'SKIPPED_AFTER_FINISH_BARRIER'
        ));
      }
      break;
    }

    beforeWave?.({ type: 'ordered', calls: [call] });
    const result = await execute(call);
    await consume(call, result);
    priorFailure ||= result?.isError === true;
    index += 1;
  }

  return { finished, parallelWaves, parallelCalls };
}
