const assert = require('assert');
const diagnostics = require('../proxy/fd-diagnostics');

function testSummarizeAgentCountsAllSocketStates() {
  const summary = diagnostics.summarizeAgent({
    sockets: { 'a:80:': [{}, {}] },
    freeSockets: { 'b:443:': [{}] },
    requests: { 'c:443:': [{}, {}, {}] },
  });

  assert.deepEqual(summary, {
    active: 2,
    free: 1,
    queued: 3,
    origins: 3,
  });
}

function testFdSnapshotClassifiesDescriptorTargets() {
  const snapshot = diagnostics.getFdSnapshot({
    readdirSync: () => ['10', '11', '12', '13'],
    readlinkSync: (entry) => ({
      '/proc/self/fd/10': 'socket:[123]',
      '/proc/self/fd/11': 'pipe:[456]',
      '/proc/self/fd/12': 'anon_inode:[eventpoll]',
      '/proc/self/fd/13': '/var/log/block-proxy.log',
    })[entry],
    readFileSync: (entry) => ({
      '/proc/net/tcp': '  sl  local_address rem_address   st\n   0: 00000000:1F41 00000000:0000 01 00000000:00000000 00:00000000 00 00000000 0 123 1\n',
      '/proc/net/tcp6': '  sl  local_address rem_address   st\n   0: 00000000:1F42 00000000:0000 08 00000000:00000000 00:00000000 00 00000000 0 999 1\n',
    })[entry],
    agents: {
      http: { sockets: { 'a:80:': [{}] }, freeSockets: {}, requests: {} },
      https: { sockets: {}, freeSockets: { 'b:443:': [{}, {}] }, requests: {} },
    },
  });

  assert.deepEqual(snapshot.descriptors, {
    total: 4,
    socket: 1,
    pipe: 1,
    anon_inode: 1,
    file: 1,
    other: 0,
  });
  assert.deepEqual(snapshot.agents.http, { active: 1, free: 0, queued: 0, origins: 1 });
  assert.deepEqual(snapshot.agents.https, { active: 0, free: 2, queued: 0, origins: 1 });
  assert.deepEqual(snapshot.socketStates, { established: 1 });
}

function testFormatSnapshotProducesParseableAggregateFields() {
  const text = diagnostics.formatSnapshot({
    descriptors: { total: 9, socket: 4, pipe: 2, anon_inode: 1, file: 2, other: 0 },
    agents: { http: { active: 1, free: 2, queued: 0, origins: 2 } },
  });

  assert.match(text, /fds_total=9/);
  assert.match(text, /fd_socket=4/);
  assert.match(text, /agent_http_active=1/);
  assert.match(text, /agent_http_free=2/);
}

function testRegisteredAgentsAreIncludedInDefaultSnapshot() {
  diagnostics.setAgents({
    proxy_http: { sockets: { 'a:80:': [{}] }, freeSockets: {}, requests: {} },
  });
  const snapshot = diagnostics.getFdSnapshot({
    readdirSync: () => [],
  });
  assert.deepEqual(snapshot.agents.proxy_http, { active: 1, free: 0, queued: 0, origins: 1 });
  diagnostics.setAgents({});
}

testSummarizeAgentCountsAllSocketStates();
testFdSnapshotClassifiesDescriptorTargets();
testFormatSnapshotProducesParseableAggregateFields();
testRegisteredAgentsAreIncludedInDefaultSnapshot();
console.log('fd diagnostics tests passed');
