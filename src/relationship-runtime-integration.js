import { IdentityPilotManager } from './identity-pilot.js';
import {
  inactiveRelationshipPilotStatus,
  RelationshipPilotManager,
  relationshipPilotConfig,
  relationshipPilotEnabled
} from './relationship-pilot.js';

const instances = new WeakMap();
let patched = false;

function getPilot(manager, create = false) {
  let pilot = instances.get(manager) || null;
  if (!pilot && create && relationshipPilotEnabled(manager?.config?.())) {
    pilot = new RelationshipPilotManager({
      identityPilot: manager,
      store: manager.store,
      sessions: manager.sessions,
      dataDir: manager.dataDir,
      config: manager.config,
      // identity-pilot.js 会用 manager.complete 捕获好友评估审计；关系评估必须绕开
      // 那个包装层，否则并发时会把 relationship-review 的请求串到 friend-review。
      complete: manager.manualFriendReviewComplete || manager.complete,
      emit: manager.emit,
      log: manager.log
    });
    instances.set(manager, pilot);
  }
  return pilot;
}

function ensureRelationshipStoreInvariants(pilot) {
  const db = pilot?.relationshipStore?.db;
  if (!db) return;
  // 多次 boundary_cross 仍然各自保留 event 并继续影响 affinity/friction，
  // 但 unresolved 状态是“存在未解决边界问题”而不是计数器。忽略重复 flag，
  // 这样一次明确 repair 就能恢复到没有遗留边界标记的状态。
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS relationship_boundary_flag_singleton
    BEFORE INSERT ON relationship_flags
    WHEN NEW.status='open'
      AND NEW.type='boundary_violation'
      AND EXISTS (
        SELECT 1 FROM relationship_flags
        WHERE uin=NEW.uin AND type=NEW.type AND status='open'
      )
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
}

function shutdownPilot(pilot) {
  if (!pilot) return;
  // 阻止队列中尚未开始的任务。已进入 LLM 请求的单个任务允许完成审计，
  // 然后再关闭 SQLite；否则 mid-flight close 会让 evaluation/session 留在半截状态。
  pilot.generation += 1;
  const store = pilot.relationshipStore;
  pilot.queued = 0;
  pilot.lastFamiliarityRefresh?.clear?.();
  if (!store) return;
  const close = () => {
    if (pilot.relationshipStore === store) pilot.relationshipStore = null;
    try { store.close(); } catch { /* ignore */ }
  };
  if (pilot.running > 0) Promise.resolve(pilot.queue).finally(close);
  else close();
}

function stopIfDisabled(manager) {
  if (relationshipPilotEnabled(manager?.config?.())) return false;
  const pilot = getPilot(manager, false);
  if (!pilot) return false;
  shutdownPilot(pilot);
  instances.delete(manager);
  return true;
}

function startIfNeeded(manager) {
  if (!relationshipPilotEnabled(manager?.config?.()) || !manager?.active) return null;
  const pilot = getPilot(manager, true);
  pilot?.start();
  ensureRelationshipStoreInvariants(pilot);
  return pilot;
}

function adminRelationshipView(pilot, person) {
  if (!pilot?.relationshipStore || !person?.userId) return null;
  const settings = relationshipPilotConfig(pilot.config());
  let state = pilot.relationshipStore.getState(person.userId, {
    halfLifeHours: settings.frictionHalfLifeHours
  });
  // 第一次打开观察面板时，为已有身份做一次 familiarity bootstrap；
  // 之后页面刷新只读状态，真正的 familiarity 更新由入站消息钩子负责。
  if (!state) state = pilot.relationshipFor(person.userId);
  if (!state) return null;
  return {
    ...state,
    shadowMode: true,
    openFlags: pilot.relationshipStore.openFlags(person.userId),
    recentEvents: pilot.relationshipStore.recentEvents(person.userId, 12)
  };
}

function patch() {
  if (patched) return;
  patched = true;
  const proto = IdentityPilotManager.prototype;

  const originalStatus = proto.status;
  if (typeof originalStatus === 'function') {
    proto.status = function relationshipAwareStatus(...args) {
      const status = originalStatus.apply(this, args);
      // /api/config 只改 relationshipPilot 时不会触发 identityPilot.reconfigure。
      // 因此 status 本身承担轻量同步：开启后在人物库 active 时启动；关闭后停止新任务。
      stopIfDisabled(this);
      const pilot = startIfNeeded(this) || getPilot(this, false);
      return {
        ...status,
        relationshipPilot: pilot?.status() || inactiveRelationshipPilotStatus()
      };
    };
  }

  const originalStart = proto.start;
  if (typeof originalStart === 'function') {
    proto.start = async function startWithRelationshipPilot(...args) {
      const result = await originalStart.apply(this, args);
      startIfNeeded(this);
      return result;
    };
  }

  const originalStop = proto.stop;
  if (typeof originalStop === 'function') {
    proto.stop = function stopWithRelationshipPilot(...args) {
      const pilot = getPilot(this, false);
      shutdownPilot(pilot);
      instances.delete(this);
      return originalStop.apply(this, args);
    };
  }

  const originalReconfigure = proto.reconfigure;
  if (typeof originalReconfigure === 'function') {
    proto.reconfigure = function reconfigureWithRelationshipPilot(...args) {
      const result = originalReconfigure.apply(this, args);
      if (relationshipPilotEnabled(this?.config?.())) startIfNeeded(this)?.reconfigure();
      else stopIfDisabled(this);
      return result;
    };
  }

  const originalObserve = proto.observeMessage;
  if (typeof originalObserve === 'function') {
    proto.observeMessage = function observeMessageWithRelationshipPilot(chatKey, message, ...rest) {
      const result = originalObserve.call(this, chatKey, message, ...rest);
      stopIfDisabled(this);
      try { startIfNeeded(this)?.observeMessage(chatKey, message); }
      catch (error) { this.log?.(`[relationship-pilot] observe hook failed: ${error?.message ?? error}`); }
      return result;
    };
  }

  const originalSuccessfulTurn = proto.handleSuccessfulTurn;
  if (typeof originalSuccessfulTurn === 'function') {
    proto.handleSuccessfulTurn = function successfulTurnWithRelationshipPilot(options = {}, ...rest) {
      const result = originalSuccessfulTurn.call(this, options, ...rest);
      Promise.resolve(result).then(() => {
        stopIfDisabled(this);
        try { startIfNeeded(this)?.handleSuccessfulTurn(options); }
        catch (error) { this.log?.(`[relationship-pilot] turn hook failed: ${error?.message ?? error}`); }
      }).catch(() => {
        // 原好友评估链失败时不额外制造关系评估副作用。
      });
      return result;
    };
  }

  // 管理端人物列表可以看到 Shadow 关系状态，用于观察轨迹。
  // 注意：故意不包装 lookupPerson()。主 Agent 的 person_memory_lookup 工具走 lookupPerson，
  // V1 Shadow Mode 下绝不能把 familiarity / affinity / friction / policy 暴露给聊天模型。
  const originalListPeople = proto.listPeople;
  if (typeof originalListPeople === 'function') {
    proto.listPeople = function listPeopleWithRelationship(limit = 100, ...rest) {
      const people = originalListPeople.call(this, limit, ...rest);
      stopIfDisabled(this);
      const pilot = startIfNeeded(this);
      if (!pilot || !Array.isArray(people)) return people;
      return people.map((person) => ({
        ...person,
        relationship: adminRelationshipView(pilot, person)
      }));
    };
  }

  proto.relationshipStatus = function relationshipStatus() {
    stopIfDisabled(this);
    return (startIfNeeded(this) || getPilot(this, false))?.status()
      || inactiveRelationshipPilotStatus();
  };

  proto.relationshipFor = function relationshipFor(userId) {
    stopIfDisabled(this);
    return startIfNeeded(this)?.relationshipFor(userId) || null;
  };
}

patch();
