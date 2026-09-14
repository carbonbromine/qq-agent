import assert from 'node:assert/strict';
import { test } from 'node:test';
import jce from 'jce';
import {
  FRIEND_REQUEST_PROTOCOL,
  FriendRequestProtocolError,
  getFriendRequestSetting,
  sendFriendRequestViaSnowLuma
} from '../src/friend-request-protocol.js';

function encodeStruct(fields) {
  return jce.encode([jce.encodeNested(fields)]);
}

function responseHex(name, fields) {
  return jce.encode([
    null,
    3,
    0,
    0,
    0,
    'mqq.IMService.FriendListServiceServantObj',
    name,
    jce.encode([{ [name === 'AddFriendReq' ? 'AFRESP' : 'FSRESP']: encodeStruct(fields) }]),
    0,
    {},
    {}
  ]).toString('hex');
}

function decodeRequest(hex) {
  const wrapper = jce.decode(Buffer.from(hex, 'hex'));
  const values = jce.decode(Buffer.from(wrapper[7]))[0];
  const nested = values[Object.keys(values)[0]];
  return jce.decode(Buffer.from(nested))[0];
}

test('friend request setting uses the verified SnowLuma raw packet action', async () => {
  const calls = [];
  const onebot = {
    call: async (...args) => {
      calls.push(args);
      return responseHex('GetUserAddFriendSettingReq', [
        3772194964,
        0,
        1,
        [],
        1,
        0,
        Buffer.alloc(0),
        0,
        Buffer.alloc(0)
      ]);
    }
  };
  assert.equal(await getFriendRequestSetting(onebot, {
    selfId: '3772194964',
    userId: '123456789'
  }), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'send_packet');
  assert.equal(calls[0][1].cmd, FRIEND_REQUEST_PROTOCOL.getSettingCommand);
  assert.match(calls[0][1].data, /^[0-9a-f]+$/);
});

test('friend request dispatch reports success only for business code zero', async () => {
  const calls = [];
  const onebot = {
    call: async (_action, params) => {
      calls.push(params);
      if (params.cmd === FRIEND_REQUEST_PROTOCOL.getSettingCommand) {
        return responseHex('GetUserAddFriendSettingReq', [
          3772194964, 0, 0, [], 1, 0, Buffer.alloc(0), 0, Buffer.alloc(0)
        ]);
      }
      return responseHex('AddFriendReq', [
        3772194964, 0, 0, 0, 0, null, 0, 0, '', Buffer.alloc(0),
        Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)
      ]);
    }
  };
  const result = await sendFriendRequestViaSnowLuma(onebot, {
    selfId: '3772194964',
    userId: '123456789',
    sourceChatKey: 'group:456',
    verificationMessage: '继续聊'
  });
  assert.deepEqual(result, {
    accepted: true,
    businessCode: 0,
    setting: 0,
    wording: ''
  });
  assert.deepEqual(calls.map((call) => call.cmd), [
    FRIEND_REQUEST_PROTOCOL.getSettingCommand,
    FRIEND_REQUEST_PROTOCOL.sendRequestCommand
  ]);
  const request = decodeRequest(calls[1].data);
  assert.equal(request[10], FRIEND_REQUEST_PROTOCOL.groupSourceId);
  assert.deepEqual(Buffer.from(request[14]), Buffer.from([0x08, 0xC8, 0x03]));
});

test('friend request dispatch keeps explicit QQ rejection distinct from unknown outcome', async () => {
  const onebot = {
    call: async (_action, params) => {
      if (params.cmd === FRIEND_REQUEST_PROTOCOL.getSettingCommand) {
        return responseHex('GetUserAddFriendSettingReq', [
          3772194964, 0, 0, [], 1, 0, Buffer.alloc(0), 0, Buffer.alloc(0)
        ]);
      }
      return responseHex('AddFriendReq', [
        3772194964, 0, 0, 0, 0, null, 1, 0, '添加失败',
        Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)
      ]);
    }
  };
  await assert.rejects(
    sendFriendRequestViaSnowLuma(onebot, {
      selfId: '3772194964',
      userId: '123456789'
    }),
    (error) => error instanceof FriendRequestProtocolError
      && error.outcome === 'failed'
      && error.businessCode === 1
      && /添加失败/.test(error.message)
  );
});

test('friend request dispatch marks a lost write response as unknown', async () => {
  let calls = 0;
  const onebot = {
    call: async () => {
      calls += 1;
      if (calls === 1) {
        return responseHex('GetUserAddFriendSettingReq', [
          3772194964, 0, 0, [], 1, 0, Buffer.alloc(0), 0, Buffer.alloc(0)
        ]);
      }
      throw new Error('socket closed');
    }
  };
  await assert.rejects(
    sendFriendRequestViaSnowLuma(onebot, {
      selfId: '3772194964',
      userId: '123456789'
    }),
    (error) => error instanceof FriendRequestProtocolError
      && error.outcome === 'unknown'
      && error.phase === 'dispatch'
  );
});

test('unsupported verification setting fails before the write request', async () => {
  let calls = 0;
  const onebot = {
    call: async () => {
      calls += 1;
      return responseHex('GetUserAddFriendSettingReq', [
        3772194964, 0, 3, [], 1, 0, Buffer.alloc(0), 0, Buffer.alloc(0)
      ]);
    }
  };
  await assert.rejects(
    sendFriendRequestViaSnowLuma(onebot, {
      selfId: '3772194964',
      userId: '123456789'
    }),
    (error) => error instanceof FriendRequestProtocolError
      && error.outcome === 'failed'
      && error.phase === 'preflight'
  );
  assert.equal(calls, 1);
});
