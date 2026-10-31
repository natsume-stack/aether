import assert from 'node:assert/strict';
import { Semaphore } from '@box/utils/semaphore';
import { ProjectRDA } from '@box/schema/project/project-rda';
import { EditReplicaServer } from '../src/edit/replica/replica-server';

async function main() {
  const mutex = new Semaphore();
  const store = ProjectRDA.createStore(ProjectRDA.stateSchema.identity);
  let dirty = 0;
  let broadcasts = 0;
  const replica: any = { _projectSemaphore: mutex, _state: { replica: { projectStore: store } },
    _setProjectDirty() { dirty++; }, _syncLocalProjectModelMembership() {},
    _protocol: { broadcast: { project() { broadcasts++; } } } };
  const commit = <T>(guard: () => void, build: () => any[], readback: () => T) =>
    EditReplicaServer.prototype.authoringProjectTransaction.call(replica, guard, build, readback);
  let revision = 'original';
  let built = false;
  try {
    await mutex.p();
    const pending = commit(() => {
      assert.equal(revision, 'original', 'Revision check runs inside the project mutex');
    }, () => { built = true; return []; }, () => undefined);
    await Promise.resolve();
    assert.equal(built, false);
    // A human edit finishes before the queued proposal can acquire the lock.
    revision = 'human-edited';
    mutex.v();
    await assert.rejects(pending, /Revision check runs inside/);
    assert.equal(built, false);
    assert.equal(dirty, 0);
    assert.equal(broadcasts, 0);
    const committed = await commit(() => undefined,
      () => [ProjectRDA.action(store).scriptIndex('checked-entry.js')],
      () => {
        assert.equal(mutex.counter, 0, 'Readback runs before releasing mutex');
        const snapshot = store.state(ProjectRDA, ProjectRDA.stateSchema.alloc());
        try { return snapshot.scriptIndex; } finally { ProjectRDA.stateSchema.free(snapshot); }
      });
    assert.equal(committed, 'checked-entry.js');
    assert.equal(dirty, 1);
    assert.equal(broadcasts, 1);
    await assert.rejects(commit(() => { throw new Error('refused'); }, () => [], () => null), /refused/);
    // A failed guard must release the mutex for future operations.
    assert.equal(await commit(() => undefined, () => [], () => 'still-available'), 'still-available');
  } finally { store.free(ProjectRDA); }
  console.log('PASS guarded project commit: mutex ordering, stale edit refusal, actual RDA write, readback under lock and lock release');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
