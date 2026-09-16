// 实验功能：依赖感知工具调度。
//
// 这个模块故意不改 Orchestrator 的主循环：宿主仍按原顺序逐个调用 executeTool。
// 开关开启时，tools.js 包装器只会提前并行启动“连续且明确只读”的调用，
// 随后仍按原始 tool_call 顺序把结果交还宿主；发送/写入始终由宿主逐个触发。
// 这样关闭开关时可以完整回退到原来的 tools-core.js 路径。

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

/**
 * 只在实验开启时改工具描述，引导模型：
 * - 独立只读调用可以同轮给出；
 * - 已经确定动作后，可以把 finish 放在同轮最后。
 * 关闭时直接返回原数组引用，确保工具 schema 与当前版本无差异。
 */
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

export function experimentalSkippedResult(message, errorCode) {
  return {
    content: `错误：${message}`,
    isError: true,
    errorCode,
    reportIncident: false,
    experimentalSkipped: true
  };
}

function callSignature(call, index = 0) {
  const fn = call?.function || {};
  return `${call?.id || index}:${String(fn.name || '')}:${String(fn.arguments ?? '{}')}`;
}

export function experimentalBatchKey(calls, round = 0) {
  return `${Number(round) || 0}|${(Array.isArray(calls) ? calls : [])
    .map((call, index) => callSignature(call, index)).join('|')}`;
}

function sameHostCall(call, name, argsRaw) {
  if (!call) return false;
  return String(call?.function?.name || '') === String(name || '')
    && String(call?.function?.arguments ?? '{}') === String(argsRaw ?? '{}');
}

/**
 * 一个 assistant tool_calls 批次对应一个协调器。
 * 宿主仍然按 index=0,1,2... 逐个来取结果；协调器只会把连续 read wave
 * 提前并行启动，绝不会提前执行发送或写入。
 */
export class ExperimentalToolBatch {
  constructor(calls, {
    execute,
    maxParallelReads = 4,
    onParallelWave = null
  } = {}) {
    if (typeof execute !== 'function') throw new TypeError('execute callback is required');
    this.calls = Array.isArray(calls) ? calls : [];
    this.execute = execute;
    this.maxParallelReads = Math.min(8, Math.max(2, Number(maxParallelReads) || 4));
    this.onParallelWave = typeof onParallelWave === 'function' ? onParallelWave : null;
    this.cursor = 0;
    this.pending = new Map();
    this.priorFailure = false;
    this.terminalSeen = false;
    this.invalid = false;
    this.parallelWaves = 0;
    this.parallelCalls = 0;
    this.finishBarrierBlocks = 0;
    this.trailingSkipped = 0;
  }

  #startReadWave(startIndex) {
    if (this.pending.has(startIndex)) return;
    const indexes = [];
    for (let i = startIndex; i < this.calls.length; i += 1) {
      if (experimentalToolEffect(this.calls[i]?.function?.name) !== 'read') break;
      indexes.push(i);
    }
    if (!indexes.length) return;

    const deferred = new Map();
    for (const index of indexes) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      deferred.set(index, { resolve, reject });
      this.pending.set(index, promise);
    }

    if (indexes.length > 1) {
      this.parallelWaves += 1;
      this.parallelCalls += indexes.length;
      this.onParallelWave?.({
        size: indexes.length,
        names: indexes.map((index) => String(this.calls[index]?.function?.name || ''))
      });
    }

    let next = 0;
    const worker = async () => {
      while (next < indexes.length) {
        const local = next++;
        const index = indexes[local];
        try {
          deferred.get(index).resolve(await this.execute(this.calls[index], index));
        } catch (error) {
          deferred.get(index).reject(error);
        }
      }
    };
    const workers = Math.min(this.maxParallelReads, indexes.length);
    // Fire-and-cache：当前宿主调用会 await 自己对应的 promise；后面的结果先缓存。
    Promise.allSettled(Array.from({ length: workers }, () => worker())).catch(() => {});
  }

  /**
   * 宿主每次调用 executeTool 时调用一次。
   * 返回 { handled, result }。handled=false 表示批次追踪与宿主不一致，调用方应退回原串行执行。
   */
  async next(name, argsRaw) {
    if (this.invalid) return { handled: false, result: null };
    const index = this.cursor;
    const call = this.calls[index];
    if (!sameHostCall(call, name, argsRaw)) {
      this.invalid = true;
      return { handled: false, result: null };
    }
    this.cursor += 1;

    if (this.terminalSeen) {
      this.trailingSkipped += 1;
      return {
        handled: true,
        result: experimentalSkippedResult(
          '未执行：finish 已形成本轮终止边界，之后的工具不能再产生副作用。',
          'SKIPPED_AFTER_FINISH_BARRIER'
        )
      };
    }

    const effect = experimentalToolEffect(name);
    if (effect === 'read') {
      this.#startReadWave(index);
      const result = await this.pending.get(index);
      this.priorFailure ||= result?.isError === true;
      return { handled: true, result };
    }

    if (effect === 'terminal') {
      this.terminalSeen = true;
      if (this.priorFailure) {
        this.finishBarrierBlocks += 1;
        return {
          handled: true,
          result: experimentalSkippedResult(
            'finish 未执行：本轮前置工具有失败项，需要先查看错误并重新决定。',
            'FINISH_BARRIER_BLOCKED'
          )
        };
      }
      const result = await this.execute(call, index);
      this.priorFailure ||= result?.isError === true;
      return { handled: true, result };
    }

    // ordered 工具绝不提前执行；只有宿主真正遍历到这里时才执行。
    const result = await this.execute(call, index);
    this.priorFailure ||= result?.isError === true;
    return { handled: true, result };
  }

  metrics() {
    return {
      parallelWaves: this.parallelWaves,
      parallelCalls: this.parallelCalls,
      finishBarrierBlocks: this.finishBarrierBlocks,
      trailingSkipped: this.trailingSkipped
    };
  }
}
