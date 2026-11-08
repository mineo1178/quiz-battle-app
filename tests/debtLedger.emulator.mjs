import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  collection, connectFirestoreEmulator, deleteDoc, doc, getDocFromServer, getDocsFromServer,
  getFirestore, setDoc, setLogLevel, terminate, updateDoc, writeBatch,
} from 'firebase/firestore';
import { balanceFor, DebtError } from '../src/debtLedger.ts';
import { saveDebtChange } from '../src/debtLedgerStore.ts';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
assert.ok(endpoint, 'Run npm run test:emulator');
const { hostname, port } = new URL('http://' + endpoint);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(hostname), 'Use a local emulator');
const project = 'demo-quiz-battle-ledger';
const actor = 'ledger-tester';
const apps = [];
setLogLevel('silent');

function client(name, uid, projectId = project) {
  const app = initializeApp({ projectId }, name);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, hostname, Number(port), uid ? { mockUserToken: { sub: uid } } : {});
  apps.push({ app, db });
  return db;
}

const authenticated = client('authenticated', actor);
const secondClient = client('second-writer', actor);
const anonymous = client('anonymous');
after(async () => {
  await Promise.all(apps.map(async ({ app, db }) => {
    await terminate(db);
    await deleteApp(app);
  }));
});

const appPath = family => `families/${family}/apps/quiz-battle`;
function ledger(db, family, entryId = 'entry') {
  const entries = collection(db, appPath(family), 'debtEntries');
  const entry = doc(entries, entryId);
  const guard = doc(db, appPath(family), 'debtLedgerState', 'writeVersion');
  return { entries, entry, guard, revision: number => doc(entry, 'revisions', String(number)) };
}

const pair = { payerId: 'father', recipientId: 'yuuka' };
const fields = { ...pair, type: 'award', amountYen: 1000, transactionDate: '2020-01-01', memo: '', matchSnapshot: null };
const first = {
  ...fields, entryId: 'entry', revision: 1, previousRevision: null, action: 'create',
  status: 'active', changeReason: '', createdBy: actor, createdAt: 1, registeredAt: 1,
};
const next = { ...first, revision: 2, previousRevision: 1, action: 'update', changeReason: '訂正', createdAt: 2 };
const denied = promise => assert.rejects(promise, { code: 'permission-denied' });
const data = async ref => (await getDocFromServer(ref)).data();

function atomic(refs, entry, { revision = entry, revisionId = entry.revision, version = entry.revision } = {}) {
  const batch = writeBatch(refs.entries.firestore);
  batch.set(refs.entry, entry);
  if (revision) batch.set(refs.revision(revisionId), revision);
  if (version !== null) batch.set(refs.guard, { version });
  return batch.commit();
}

async function seeded(family) {
  const refs = ledger(authenticated, family);
  await atomic(refs, first);
  return refs;
}

test('Rules allow authenticated reads and reject unauthenticated read/create/update/delete', async () => {
  const refs = await seeded('authentication');
  const blocked = ledger(anonymous, 'authentication');
  assert.deepEqual(await data(refs.entry), first);
  for (const ref of [blocked.entry, blocked.revision(1), blocked.guard]) {
    await denied(getDocFromServer(ref));
  }
  await denied(atomic(ledger(anonymous, 'anonymous-create'), first));
  await denied(atomic(blocked, next));
  await denied(deleteDoc(blocked.entry));
});

test('Rules accept atomic current/revision/guard creation and update', async () => {
  const refs = await seeded('atomic');
  assert.deepEqual(await data(refs.revision(1)), first);
  await atomic(refs, next);
  assert.deepEqual(await data(refs.entry), next);
  assert.deepEqual(await data(refs.revision(2)), next);
  assert.deepEqual(await data(refs.guard), { version: 2 });
});

test('Rules reject current deletion and standalone create/update', async () => {
  const refs = await seeded('current');
  await denied(deleteDoc(refs.entry));
  await denied(setDoc(ledger(authenticated, 'standalone-current').entry, first));
  await denied(setDoc(refs.entry, next));
  await denied(atomic(refs, next, { revision: null }));
  assert.deepEqual(await data(refs.entry), first);
});

test('Rules reject wrong entry IDs, skipped revisions, bad previousRevision and invalid transitions', async () => {
  const refs = await seeded('transitions');
  for (const change of [
    { entryId: 'wrong' }, { revision: 3 }, { previousRevision: 0 },
    { status: 'voided' }, { action: 'create' }, { createdBy: 'another-user' },
    { action: 'void', status: 'voided', amountYen: 1 },
  ]) {
    await denied(atomic(refs, { ...next, ...change }, { version: 2 }));
  }
  const voided = { ...next, action: 'void', status: 'voided' };
  await atomic(refs, voided);
  await denied(atomic(refs, { ...next, revision: 3, previousRevision: 2, createdAt: 3 }));
});

test('Rules reject revision updates, deletions and overwrites', async () => {
  const refs = await seeded('immutable');
  await denied(updateDoc(refs.revision(1), { memo: 'changed' }));
  await denied(deleteDoc(refs.revision(1)));
  await denied(setDoc(refs.revision(1), first));
  await denied(atomic(refs, next, { revisionId: 1 }));
  assert.deepEqual(await data(refs.revision(1)), first);
});

test('Rules reject standalone, mismatched and incorrectly numbered revisions', async () => {
  const empty = ledger(authenticated, 'revision-only');
  await denied(setDoc(empty.revision(1), first));
  const refs = await seeded('revision-match');
  await denied(setDoc(refs.revision(2), next));
  await denied(atomic(refs, next, { revision: { ...next, memo: 'different' } }));
  await denied(atomic(refs, next, { revisionId: '02' }));
  assert.equal(await data(refs.revision(2)), undefined);
});

test('Rules require a guard advance for ledger writes and reject guard resets, extra fields and deletion', async () => {
  const empty = ledger(authenticated, 'guard-create');
  await denied(setDoc(empty.guard, { version: 2 }));
  await denied(atomic(empty, first, { version: null }));
  const refs = await seeded('guard-update');
  await denied(atomic(refs, next, { version: null }));
  for (const value of [{ version: 1 }, { version: 99 }, { version: 2, other: true }, { version: 2.5 }]) {
    await denied(setDoc(refs.guard, value));
  }
  await denied(deleteDoc(refs.guard));
  await atomic(refs, next);
  assert.deepEqual(await data(refs.guard), { version: 2 });
});

async function checkExistingAccess(signedIn, signedOut) {
  for (const path of [
    'families/regression', appPath('regression'), appPath('other-family'),
    appPath('regression') + '/players/player', appPath('regression') + '/matches/match',
    appPath('regression') + '/other/doc/nested/child', 'families/regression/apps/other/debtEntries/doc',
  ]) {
    const allowed = doc(signedIn, path);
    const blocked = doc(signedOut, path);
    await denied(setDoc(blocked, { value: 0 }));
    await setDoc(allowed, { value: 1 });
    await denied(getDocFromServer(blocked));
    await denied(updateDoc(blocked, { value: 2 }));
    await denied(deleteDoc(blocked));
    assert.deepEqual(await data(allowed), { value: 1 });
    await updateDoc(allowed, { value: 2 });
    assert.deepEqual(await data(allowed), { value: 2 });
    await deleteDoc(allowed);
  }
  for (const name of ['players', 'matches']) {
    await getDocsFromServer(collection(signedIn, appPath('regression'), name));
    await denied(getDocsFromServer(collection(signedOut, appPath('regression'), name)));
  }
  await denied(setDoc(doc(signedIn, 'outside/document'), { value: 1 }));
}

test('Rules preserve existing family, app, players and matches permissions', async () => {
  const backupPath = process.env.DEBT_LEDGER_RULES_BASELINE;
  if (backupPath) {
    const { files } = JSON.parse(await readFile(backupPath, 'utf8'));
    const baselineProject = project + '-baseline';
    const response = await fetch(`http://${endpoint}/emulator/v1/projects/${baselineProject}:securityRules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { files } }),
    });
    assert.ok(response.ok, await response.text());
    await checkExistingAccess(client('baseline-in', actor, baselineProject), client('baseline-out', null, baselineProject));
  }
  await checkExistingAccess(authenticated, anonymous);
});

const save = (refs, change) => saveDebtChange(refs.entries, change, actor, assert.fail);

test('Integration creates current and revision 1 and advances the guard', async () => {
  const refs = ledger(authenticated, 'store-create');
  const created = await save(refs, { action: 'create', fields });
  const actual = ledger(authenticated, 'store-create', created.entryId);
  assert.equal(created.revision, 1);
  assert.deepEqual(await data(actual.entry), created);
  assert.deepEqual(await data(actual.revision(1)), created);
  assert.deepEqual(await data(actual.guard), { version: 1 });
});

test('Integration updates and voids current while preserving all earlier revisions', async () => {
  const refs = ledger(authenticated, 'store-history');
  const created = await save(refs, { action: 'create', fields });
  const actual = ledger(authenticated, 'store-history', created.entryId);
  const updated = await save(refs, { action: 'update', previous: created, fields: { ...fields, amountYen: 750 }, reason: '訂正' });
  assert.equal(updated.revision, 2);
  assert.deepEqual(await data(actual.entry), updated);
  assert.deepEqual(await data(actual.revision(2)), updated);
  assert.deepEqual(await data(actual.revision(1)), created);
  assert.deepEqual(await data(actual.guard), { version: 2 });
  const voided = await save(refs, { action: 'void', previous: updated, reason: '取消' });
  assert.equal(voided.status, 'voided');
  assert.equal(voided.revision, 3);
  assert.deepEqual(await data(actual.entry), voided);
  assert.deepEqual(await data(actual.revision(1)), created);
  assert.deepEqual(await data(actual.revision(2)), updated);
  assert.deepEqual(await data(actual.revision(3)), voided);
  assert.deepEqual(await data(actual.guard), { version: 3 });
});

test('Integration serializes two concurrent ¥700 payments against a ¥1,000 award', async () => {
  const family = 'store-race';
  const refs = ledger(authenticated, family);
  const other = ledger(secondClient, family);
  const award = await save(refs, { action: 'create', fields });
  const payment = { action: 'create', fields: { ...fields, type: 'payment', amountYen: 700 } };
  const results = await Promise.allSettled([save(refs, payment), save(other, payment)]);
  const succeeded = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(succeeded.length, 1, String(rejected[0]?.reason));
  assert.ok(rejected[0].reason instanceof DebtError);
  assert.match(rejected[0].reason.message, /残高が .* にマイナス/);
  const paid = succeeded[0].value;
  assert.notEqual(paid.entryId, award.entryId);
  const entries = (await getDocsFromServer(refs.entries)).docs.map(snapshot => snapshot.data());
  assert.equal(entries.length, 2);
  assert.equal(balanceFor(entries, pair), 300);
  for (const entry of [award, paid]) {
    const actual = ledger(authenticated, family, entry.entryId);
    assert.deepEqual(await data(actual.entry), entry);
    assert.deepEqual(await data(actual.revision(1)), entry);
    assert.equal((await getDocsFromServer(collection(actual.entry, 'revisions'))).size, 1);
  }
  assert.deepEqual(await data(refs.guard), { version: 2 });
});
