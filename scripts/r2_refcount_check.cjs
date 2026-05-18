// Unit-style check for the refcount logic transplanted from server.ts.
// Confirms: same key set N times → first (N-1) deletes keep the object,
// the Nth delete actually fires. Distinct keys + extend_video case also covered.

const taskToR2Keys = new Map();
const r2KeyRefCount = new Map();
const deletes = [];

function setTask(taskId, keys) {
  taskToR2Keys.set(taskId, keys);
  for (const k of keys) r2KeyRefCount.set(k, (r2KeyRefCount.get(k) || 0) + 1);
}
function scheduleR2Delete(taskId) {
  const keys = taskToR2Keys.get(taskId);
  if (!keys) return;
  taskToR2Keys.delete(taskId);
  for (const key of keys) {
    const remaining = (r2KeyRefCount.get(key) || 1) - 1;
    if (remaining > 0) { r2KeyRefCount.set(key, remaining); continue; }
    r2KeyRefCount.delete(key);
    deletes.push(key);
  }
}

function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

// Case 1: single task, single key
deletes.length = 0;
setTask('t1', ['key-A']);
assert(r2KeyRefCount.get('key-A') === 1, 'single task: ref=1');
scheduleR2Delete('t1');
assert(deletes.length === 1 && deletes[0] === 'key-A', 'single task: deletes key-A');
assert(!r2KeyRefCount.has('key-A'), 'single task: ref map cleared');

// Case 2: output_count=3 → same key in 3 tasks
deletes.length = 0;
setTask('outA', ['key-B']); setTask('outB', ['key-B']); setTask('outC', ['key-B']);
assert(r2KeyRefCount.get('key-B') === 3, 'output_count=3: ref=3');
scheduleR2Delete('outA');
assert(deletes.length === 0 && r2KeyRefCount.get('key-B') === 2, 'after 1st done: kept, ref=2');
scheduleR2Delete('outB');
assert(deletes.length === 0 && r2KeyRefCount.get('key-B') === 1, 'after 2nd done: kept, ref=1');
scheduleR2Delete('outC');
assert(deletes.length === 1 && deletes[0] === 'key-B', 'after 3rd done: actually deleted');
assert(!r2KeyRefCount.has('key-B'), 'output_count=3: ref map cleared');

// Case 3: extend_video → one task with 3 distinct keys
deletes.length = 0;
setTask('ext1', ['ev-1', 'ev-2', 'ev-3']);
assert(r2KeyRefCount.get('ev-1') === 1 && r2KeyRefCount.get('ev-2') === 1 && r2KeyRefCount.get('ev-3') === 1, 'extend_video: each ref=1');
scheduleR2Delete('ext1');
assert(deletes.length === 3, 'extend_video: all 3 deleted in one shot');

// Case 4: idempotent — same task delete called twice
deletes.length = 0;
setTask('idem', ['key-C']);
scheduleR2Delete('idem');
scheduleR2Delete('idem'); // poll cycle may see succeeded twice
assert(deletes.length === 1, 'idempotent: 2nd schedule is noop');

// Case 5: mixed — 2 parallel outputs of an extend_video with 2 videos
deletes.length = 0;
setTask('mixA', ['k1', 'k2']); setTask('mixB', ['k1', 'k2']);
scheduleR2Delete('mixA');
assert(deletes.length === 0 && r2KeyRefCount.get('k1') === 1 && r2KeyRefCount.get('k2') === 1, 'mixed: first done keeps both');
scheduleR2Delete('mixB');
assert(deletes.length === 2 && deletes.includes('k1') && deletes.includes('k2'), 'mixed: second done deletes both');
