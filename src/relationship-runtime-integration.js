import { IdentityPilotManager } from './identity-pilot.js';
import {
  inactiveRelationshipPilotStatus,
  RelationshipPilotManager,
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

function startIfNeeded(manager) {
  if (!relationshipPilotEnabled(manager?.config?.()) || !manager?.active) return null;
  const pilot = getPilot(manager, true);
  pilot?.start();
  return pilot;
}

function patch() {
  if (patched) return;
  patched = true;
  const proto = IdentityPilotManager.prototype;

  const originalStatus = proto.status;
  if (typeof originalStatus === 'function') {
    proto.status = function relationshipAwareStatus(...args) {
      const status = originalStatus.apply(this, args);
      const pilot = getPilot(this, false);
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
      pilot?.stop();
      instances.delete(this);
      return originalStop.apply(this, args);
    };
  }

  const originalReconfigure = proto.reconfigure;
  if (typeof originalReconfigure === 'function') {
    proto.reconfigure = function reconfigureWithRelationshipPilot(...args) {
      const result = originalReconfigure.apply(this, args);
      if (relationshipPilotEnabled(this?.config?.())) startIfNeeded(this)?.reconfigure();
      else {
        getPilot(this, false)?.stop();
        instances.delete(this);
      }
      return result;
    };
  }

  const originalObserve = proto.observeMessage;
  if (typeof originalObserve === 'function') {
    proto.observeMessage = function observeMessageWithRelationshipPilot(chatKey, message, ...rest) {
      const result = originalObserve.call(this, chatKey, message, ...rest);
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
        try { startIfNeeded(this)?.handleSuccessfulTurn(options); }
        catch (error) { this.log?.(`[relationship-pilot] turn hook failed: ${error?.message ?? error}`); }
      }).catch(() => {
        // 原好友评估链失败时不额外制造关系评估副作用。
      });
      return result;
    };
  }

  const originalListPeople = proto.listPeople;
  if (typeof originalListPeople === 'function') {
    proto.listPeople = function listPeopleWithRelationship(limit = 100, ...rest) {
      const people = originalListPeople.call(this, limit, ...rest);
      const pilot = startIfNeeded(this);
      if (!pilot || !Array.isArray(people)) return people;
      return people.map((person) => pilot.augmentPerson(person));
    };
  }

  const originalLookupPerson = proto.lookupPerson;
  if (typeof originalLookupPerson === 'function') {
    proto.lookupPerson = function lookupPersonWithRelationship(userId, options = {}, ...rest) {
      const person = originalLookupPerson.call(this, userId, options, ...rest);
      const pilot = startIfNeeded(this);
      return pilot ? pilot.augmentPerson(person) : person;
    };
  }

  proto.relationshipStatus = function relationshipStatus() {
    return getPilot(this, false)?.status() || inactiveRelationshipPilotStatus();
  };

  proto.relationshipFor = function relationshipFor(userId) {
    return startIfNeeded(this)?.relationshipFor(userId) || null;
  };
}

patch();
