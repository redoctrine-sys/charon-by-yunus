import { db } from './db/connection.js';
import { now } from './utils.js';

let _state = null;

function loadState() {
  const row = db.prepare('SELECT state FROM agent_current_state WHERE id = 1').get();
  _state = row?.state || 'running';
}

export function agentState() {
  if (_state === null) loadState();
  return _state;
}

export function setState(newState, reason = '', triggeredBy = 'system') {
  if (_state === null) loadState();
  const oldState = _state;
  if (oldState === newState) return;
  _state = newState;
  const ts = now();
  db.prepare(`UPDATE agent_current_state SET state = ?, changed_at_ms = ?, reason = ? WHERE id = 1`).run(newState, ts, reason || null);
  db.prepare(`INSERT INTO agent_state_log (old_state, new_state, reason, triggered_by, created_at_ms) VALUES (?, ?, ?, ?, ?)`).run(oldState, newState, reason || null, triggeredBy, ts);
  console.log(`[agent] state: ${oldState} → ${newState} (${triggeredBy}: ${reason || 'no reason'})`);
}

export function canEnterNewPositions() { return agentState() === 'running'; }
export function canMonitorPositions() { return agentState() !== 'stopped'; }
export function isRunning() { return agentState() === 'running'; }
