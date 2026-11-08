import { FirebaseError } from 'firebase/app';
import {
  collection, doc, getDocFromServer, getDocsFromServer, onSnapshot, runTransaction,
} from 'firebase/firestore';
import type { CollectionReference, DocumentData, FirestoreError } from 'firebase/firestore';
import { prepareRevision } from './debtLedger.ts';
import type { DebtChange, DebtEntry } from './debtLedger';

const sampleKey = 'quiz_debt_ledger_sample_v1';
type LedgerRef = CollectionReference<DocumentData>;
const readSample = (): DebtEntry[] => JSON.parse(localStorage.getItem(sampleKey) ?? '[]');

export function watchEntries(ref: LedgerRef | null, onEntries: (entries: DebtEntry[]) => void, onError: (error: unknown) => void) {
  if (ref) {
    return onSnapshot(ref, snapshot => onEntries(snapshot.docs.map(entry => entry.data() as DebtEntry)), onError);
  }
  const refresh = () => {
    try {
      onEntries(readSample());
    } catch (error) {
      onError(error);
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === sampleKey || event.key === null) refresh();
  };
  window.addEventListener('storage', onStorage);
  refresh();
  return () => window.removeEventListener('storage', onStorage);
}

export function watchRevisions(
  ref: LedgerRef, entryId: string,
  onEntries: (entries: DebtEntry[]) => void, onError: (error: FirestoreError) => void,
) {
  return onSnapshot(collection(doc(ref, entryId), 'revisions'), snapshot => {
    onEntries(snapshot.docs.map(entry => entry.data() as DebtEntry));
  }, onError);
}

export async function saveDebtChange(
  ref: LedgerRef | null, change: DebtChange, actor: string, onSampleEntries: (entries: DebtEntry[]) => void,
) {
  if (!ref) {
    const save = () => {
      const entries = readSample();
      const id = change.action === 'create' ? crypto.randomUUID() : change.previous.entryId;
      const next = prepareRevision(entries, id, change, Date.now(), actor);
      const updated = [...entries, next];
      localStorage.setItem(sampleKey, JSON.stringify(updated));
      onSampleEntries(updated);
      return next;
    };
    // Browsers supporting Web Locks serialize writes across tabs.
    return navigator.locks ? navigator.locks.request(sampleKey, save) : save();
  }

  const target = change.action === 'create' ? doc(ref) : doc(ref, change.previous.entryId);
  const app = ref.parent;
  if (!app) throw new Error('Ledger must belong to an app');
  const guard = doc(app, 'debtLedgerState', 'writeVersion');
  for (let retries = 0; ; retries++) {
    let observedVersion = 0;
    try {
      return await runTransaction(ref.firestore, async transaction => {
        // Read the guard before the server query so an intervening write invalidates validation.
        const version = await transaction.get(guard);
        observedVersion = version.data()?.version ?? 0;
        const snapshot = await getDocsFromServer(ref);
        const entries = snapshot.docs.map(entry => entry.data() as DebtEntry);
        const next = prepareRevision(entries, target.id, change, Date.now(), actor);
        const revisionRef = doc(collection(target, 'revisions'), String(next.revision));
        const revision = await transaction.get(revisionRef);
        if (revision.exists()) throw new Error('Revision already exists');
        transaction.set(guard, { version: observedVersion + 1 });
        transaction.set(target, next);
        transaction.set(revisionRef, next);
        return next;
      });
    } catch (error) {
      // Rules can reject a stale +1 before Firestore checks the transaction precondition.
      if (retries >= 4 || !(error instanceof FirebaseError) || error.code !== 'permission-denied') throw error;
      const current = await getDocFromServer(guard).catch(() => null);
      if (!current || (current.data()?.version ?? 0) <= observedVersion) throw error;
    }
  }
}
