import {
  collection, doc, getDocsFromServer, onSnapshot, runTransaction,
} from 'firebase/firestore';
import type { CollectionReference, DocumentData, FirestoreError } from 'firebase/firestore';
import { prepareRevision } from './debtLedger';
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
  return runTransaction(ref.firestore, async transaction => {
    // Read the version before the server query. Every ledger writer advances it
    // in the same commit, so an intervening write forces a retry of validation.
    const version = await transaction.get(guard);
    const snapshot = await getDocsFromServer(ref);
    const entries = snapshot.docs.map(entry => entry.data() as DebtEntry);
    const next = prepareRevision(entries, target.id, change, Date.now(), actor);
    const revisionRef = doc(collection(target, 'revisions'), String(next.revision));
    const revision = await transaction.get(revisionRef);
    if (revision.exists()) throw new Error('Revision already exists');
    transaction.set(guard, { version: (version.data()?.version ?? 0) + 1 });
    transaction.set(target, next);
    transaction.set(revisionRef, next);
    return next;
  });
}
