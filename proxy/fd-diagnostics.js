'use strict';

const fs = require('fs');

const FD_PATH = '/proc/self/fd';
const TCP_STATE_NAMES = {
  '01': 'established', '02': 'syn_sent', '03': 'syn_recv', '04': 'fin_wait1',
  '05': 'fin_wait2', '06': 'time_wait', '07': 'close', '08': 'close_wait',
  '09': 'last_ack', '0A': 'listen', '0B': 'closing',
};
let registeredAgents = {};

function setAgents(agents) {
  registeredAgents = agents || {};
}

function countEntries(collection) {
  return Object.values(collection || {}).reduce((total, entries) => {
    return total + (Array.isArray(entries) ? entries.length : 0);
  }, 0);
}

function summarizeAgent(agent) {
  const sockets = agent || {};
  const active = countEntries(sockets.sockets);
  const free = countEntries(sockets.freeSockets);
  const queued = countEntries(sockets.requests);
  const origins = new Set([
    ...Object.keys(sockets.sockets || {}),
    ...Object.keys(sockets.freeSockets || {}),
    ...Object.keys(sockets.requests || {}),
  ]).size;
  return { active, free, queued, origins };
}

function classifyTarget(target) {
  if (target.startsWith('socket:[')) return 'socket';
  if (target.startsWith('pipe:[')) return 'pipe';
  if (target.startsWith('anon_inode:')) return 'anon_inode';
  if (target.startsWith('/')) return 'file';
  return 'other';
}

function getSocketStates(socketInodes, readFileSync) {
  const states = {};
  if (socketInodes.size === 0) return states;
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const lines = readFileSync(path, 'utf8').trim().split('\n').slice(1);
      for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        const state = TCP_STATE_NAMES[fields[3]];
        const inode = fields[9];
        if (state && socketInodes.has(inode)) states[state] = (states[state] || 0) + 1;
      }
    } catch (_) {}
  }
  return states;
}

function getFdSnapshot(options = {}) {
  const readdirSync = options.readdirSync || fs.readdirSync;
  const readlinkSync = options.readlinkSync || fs.readlinkSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const fdPath = options.fdPath || FD_PATH;
  const descriptors = { total: 0, socket: 0, pipe: 0, anon_inode: 0, file: 0, other: 0 };
  const socketInodes = new Set();

  try {
    for (const fd of readdirSync(fdPath)) {
      descriptors.total++;
      try {
        const target = readlinkSync(`${fdPath}/${fd}`);
        const category = classifyTarget(target);
        descriptors[category]++;
        const socketMatch = /^socket:\[(\d+)\]$/.exec(target);
        if (socketMatch) socketInodes.add(socketMatch[1]);
      } catch (_) {
        descriptors.other++;
      }
    }
  } catch (_) {
    descriptors.total = null;
  }

  const agents = {};
  const sourceAgents = options.agents === undefined ? registeredAgents : options.agents;
  for (const [name, agent] of Object.entries(sourceAgents || {})) {
    agents[name] = summarizeAgent(agent);
  }
  return { descriptors, socketStates: getSocketStates(socketInodes, readFileSync), agents };
}

function formatSnapshot(snapshot) {
  const fields = [];
  for (const [name, value] of Object.entries(snapshot.descriptors || {})) {
    const key = name === 'total' ? 'fds_total' : `fd_${name}`;
    fields.push(`${key}=${value === null ? 'unknown' : value}`);
  }
  for (const [state, value] of Object.entries(snapshot.socketStates || {})) {
    fields.push(`tcp_${state}=${value}`);
  }
  for (const [name, summary] of Object.entries(snapshot.agents || {})) {
    for (const [metric, value] of Object.entries(summary)) {
      fields.push(`agent_${name}_${metric}=${value}`);
    }
  }
  return fields.join(' ');
}

module.exports = { summarizeAgent, getFdSnapshot, formatSnapshot, setAgents };
