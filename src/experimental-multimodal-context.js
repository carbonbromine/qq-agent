// 实验功能：多模态生命周期续接。
//
// 当前 lifecycle 在 provider transcript 中发现 inline image 时会用
// multimodal-context 原因强制 rollover。这个试点只改“提交阶段”：图片仍在当前
// Agent Session 中原样交给视觉模型，但跨 Session 持久化时改写成小型文本交接，
// 从而保留既有 threadId / provider prefix。关闭开关时直接调用原
// ChatStore.commitLifecycleRun，参数对象和现有行为都不改变。
import { getConfig } from './config.js';
import { ChatStore } from './store.js';
import {
  DEFAULT_MULTIMODAL_CONTEXT_PILOT,
  canonicalMultimodalMessages,
  multimodalContextPilotConfig,
  rewriteMultimodalLifecycleCommit
} from './experimental-multimodal-context-core.js';

const INSTALL_MARK = Symbol.for('qq-agent.experimental-multimodal-context-installed');

export {
  DEFAULT_MULTIMODAL_CONTEXT_PILOT,
  canonicalMultimodalMessages,
  multimodalContextPilotConfig,
  rewriteMultimodalLifecycleCommit
};

export function installExperimentalMultimodalContextPilot({
  StoreClass = ChatStore,
  getConfigFn = getConfig
} = {}) {
  const proto = StoreClass?.prototype;
  if (!proto || typeof proto.commitLifecycleRun !== 'function') {
    throw new TypeError('ChatStore.commitLifecycleRun is required');
  }
  if (proto[INSTALL_MARK]) return false;

  const original = proto.commitLifecycleRun;
  Object.defineProperty(proto, INSTALL_MARK, {
    value: { original },
    configurable: false,
    enumerable: false,
    writable: false
  });

  proto.commitLifecycleRun = function experimentalMultimodalContextCommit(options = {}) {
    // 最热路径先按 reason 旁路：普通 lifecycle commit 连配置读取都不增加。
    if (options?.forceRollover !== 'multimodal-context') {
      return original.call(this, options);
    }
    const cfg = getConfigFn();
    if (cfg?.multimodalContextPilot?.enabled !== true) {
      return original.call(this, options);
    }
    return original.call(
      this,
      rewriteMultimodalLifecycleCommit(this, options, cfg)
    );
  };
  return true;
}
