import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Row = { version: 1; kind: 'intent' | 'result' | 'event'; runtimeId: string; payload: Record<string, any> };

/** Bounded, fsync'ed write-ahead evidence. Never stores tool arguments or undo data.
 * A valid prefix survives a torn final append. Corruption elsewhere fails closed.
 */
export class AuthoringJournal {
  private file: string;
  private bytes = 0;
  private limit: number;
  readonly rows: Row[] = [];
  private lock: string;
  private owner = `${process.pid}:${randomUUID()}`;
  private release = () => {
    try { if (fs.readFileSync(this.lock, 'utf8') === this.owner) fs.unlinkSync(this.lock); } catch { /* already released */ }
  };

  close() { this.release(); process.off('exit', this.release); }

  constructor(file: string, limit = 32 * 1024 * 1024) {
    this.file = file;
    this.lock = `${file}.lock`;
    this.limit = limit;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(this.lock, this.owner, { flag: 'wx', mode: 0o600 });
    } catch {
      const owner = fs.readFileSync(this.lock, 'utf8');
      const pid = Number(owner.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('AUTHORING_JOURNAL_LOCK_INVALID');
      let live = true;
      try { process.kill(pid, 0); } catch (error) { live = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (live) throw new Error('AUTHORING_JOURNAL_IN_USE');
      if (fs.readFileSync(this.lock, 'utf8') !== owner) throw new Error('AUTHORING_JOURNAL_LOCK_CHANGED');
      fs.unlinkSync(this.lock);
      fs.writeFileSync(this.lock, this.owner, { flag: 'wx', mode: 0o600 });
    }
    process.once('exit', this.release);
    try {
    const raw = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    if (raw.length > limit) throw new Error('AUTHORING_JOURNAL_CAPACITY');
    const last = raw.lastIndexOf(10);
    const complete = raw.subarray(0, last + 1);
    for (const line of complete.toString('utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.digest !== createHash('sha256').update(JSON.stringify(record.row)).digest('hex') || record.row.version !== 1
        || !['intent','result','event'].includes(record.row.kind)) throw new Error('AUTHORING_JOURNAL_CORRUPT');
      if (record.row.kind === 'intent' && (!/^[\w:.-]{1,160}$/.test(record.row.payload?.operationId || '')
        || !/^[a-f0-9]{64}$/.test(record.row.payload?.fingerprint || ''))) throw new Error('AUTHORING_JOURNAL_CORRUPT');
      this.rows.push(record.row);
    }
    // The incomplete suffix is never interpreted as an executable operation.
    if (complete.length !== raw.length) fs.truncateSync(file, complete.length);
    this.bytes = complete.length;
    } catch (error) { this.close(); throw error; }
  }

  reserve() {
    if (this.bytes + 65536 > this.limit) throw new Error('AUTHORING_JOURNAL_CAPACITY');
  }

  append(kind: Row['kind'], runtimeId: string, payload: Record<string, any>) {
    if (fs.readFileSync(this.lock, 'utf8') !== this.owner) throw new Error('AUTHORING_JOURNAL_LOCK_CHANGED');
    if ((fs.existsSync(this.file) ? fs.statSync(this.file).size : 0) !== this.bytes) throw new Error('AUTHORING_JOURNAL_CHANGED');
    const row: Row = { version: 1, kind, runtimeId, payload };
    const encoded = JSON.stringify(row);
    const line = JSON.stringify({ row, digest: createHash('sha256').update(encoded).digest('hex') }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.bytes + bytes > this.limit) throw new Error('AUTHORING_JOURNAL_CAPACITY');
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.bytes += bytes;
    this.rows.push(row);
  }

  history(limit = 100) {
    return this.rows.filter(row => row.kind === 'event').slice(-Math.min(1000, Math.max(1, limit)));
  }

  loadProposals(): Record<string, any>[] {
    const file = `${this.file}.proposals.json`;
    if (!fs.existsSync(file)) return [];
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('PROPOSAL_STORE_CAPACITY');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || !Array.isArray(record.proposals) || record.proposals.length > 100
      || record.digest !== createHash('sha256').update(JSON.stringify(record.proposals)).digest('hex')) throw new Error('PROPOSAL_STORE_CORRUPT');
    for (const p of record.proposals) {
      if (typeof p.id !== 'string' || typeof p.baseRevision !== 'string' || !Array.isArray(p.undo)
        || (p.domain !== undefined && !['script', 'entities', 'entityLifecycle', 'ui', 'terrain'].includes(p.domain))
        || !p.undo.every((token: unknown) => typeof token === 'string') || !Array.isArray(p.previews)
        || !['proposed','expired','discarded','applying','applied','partial','unknown','reverting','reverted'].includes(p.status)) throw new Error('PROPOSAL_STORE_CORRUPT');
    }
    return record.proposals;
  }

  saveProposals(proposals: Record<string, any>[]) {
    if (fs.readFileSync(this.lock, 'utf8') !== this.owner) throw new Error('AUTHORING_JOURNAL_LOCK_CHANGED');
    // Retain domain inverse data and review previews locally. Script previews
    // and inverse snippets contain author text; the JSONL journal does not.
    // Executable forward steps are deliberately not persisted.
    const values = proposals.map(p => ({ id: p.id, domain: p.domain, baseRevision: p.baseRevision, previews: p.previews,
      status: p.status, undo: p.undo, revision: p.revision, stepCount: p.stepCount ?? p.steps.length }));
    const encoded = JSON.stringify({ version: 1, proposals: values,
      digest: createHash('sha256').update(JSON.stringify(values)).digest('hex') });
    if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new Error('PROPOSAL_STORE_CAPACITY');
    const target = `${this.file}.proposals.json`;
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, target);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  loadPlans(): Record<string, any>[] {
    const file = `${this.file}.plans.json`;
    if (!fs.existsSync(file)) return [];
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('PLAN_STORE_CAPACITY');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || !Array.isArray(record.plans) || record.plans.length > 50 ||
      record.digest !== createHash('sha256').update(JSON.stringify(record.plans)).digest('hex')) throw new Error('PLAN_STORE_CORRUPT');
    for (const plan of record.plans) {
      if (typeof plan.id !== 'string' || !Array.isArray(plan.members) || plan.members.length < 1 || plan.members.length > 16 ||
        !plan.members.every((member: any) => typeof member.proposalId === 'string' && typeof member.domain === 'string' && typeof member.baseRevision === 'string') ||
        !['proposed','expired','applying','applied','reverting','reverted','discarded','compensated','unknown'].includes(plan.status) ||
        !Number.isSafeInteger(plan.appliedCount) || plan.appliedCount < 0 || plan.appliedCount > plan.members.length ||
        !plan.revisions || typeof plan.revisions !== 'object') throw new Error('PLAN_STORE_CORRUPT');
    }
    return record.plans;
  }

  savePlans(plans: Record<string, any>[]) {
    if (fs.readFileSync(this.lock, 'utf8') !== this.owner) throw new Error('AUTHORING_JOURNAL_LOCK_CHANGED');
    const encoded = JSON.stringify({version: 1, plans, digest: createHash('sha256').update(JSON.stringify(plans)).digest('hex')});
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('PLAN_STORE_CAPACITY');
    const target = `${this.file}.plans.json`;
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
      fs.renameSync(temp, target);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }

}
