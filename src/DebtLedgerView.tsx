import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CollectionReference, DocumentData } from 'firebase/firestore';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { balanceFor, compareEntries, DebtError, graphPairs, graphPoints, latestEntries, people, personIds, validPair } from './debtLedger';
import type { DebtChange, DebtEntry, DebtType, MatchSnapshot, Pair, Period, PersonId } from './debtLedger';
import { saveDebtChange, watchEntries, watchRevisions } from './debtLedgerStore';

const yen = (amount: number) => '¥' + amount.toLocaleString('ja-JP');
const typeName = (type: DebtType) => type === 'award' ? '賞金' : '支払い';
const pairName = (pair: Pair) => people[pair.payerId] + ' → ' + people[pair.recipientId];
const signedYen = (entry: DebtEntry) => (entry.type === 'award' ? '+' : '-') + yen(entry.amountYen);
const panel = 'min-w-0 space-y-3 rounded-xl bg-white p-4 shadow-sm';
const field = 'block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2 text-slate-800';
const button = 'rounded-lg bg-blue-600 px-3 py-2 font-bold text-white disabled:opacity-50';
const secondary = 'rounded-lg bg-slate-100 px-3 py-2 font-bold text-slate-700 disabled:opacity-50';
const periods = { all: '全期間', year: '今年', month: '今月' } as const;

type LedgerRef = CollectionReference<DocumentData> | null;
type AwardSeed = { matchSnapshot: MatchSnapshot; pair?: Pair };
type Draft = { type: DebtType; seed?: AwardSeed; previous?: DebtEntry; voiding?: boolean };

function PairFields({ value, onChange }: { value: Pair; onChange: (pair: Pair) => void }) {
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2">
      <label className="min-w-0 text-sm">借りている人
        <select className={field} value={value.payerId} required onChange={event => {
          const payerId = event.target.value as PersonId;
          onChange({ payerId, recipientId: payerId === value.recipientId ? '' as PersonId : value.recipientId });
        }}>
          <option value="">選択してください</option>
          {personIds.map(id => <option key={id} value={id}>{people[id]}</option>)}
        </select>
      </label>
      <label className="min-w-0 text-sm">相手
        <select className={field} value={value.recipientId} required onChange={event => {
          onChange({ ...value, recipientId: event.target.value as PersonId });
        }}>
          <option value="">選択してください</option>
          {personIds.filter(id => id !== value.payerId).map(id => <option key={id} value={id}>{people[id]}</option>)}
        </select>
      </label>
    </div>
  );
}

function EntryForm({ draft, entries, today, onSave, onBack }: {
  draft: Draft; entries: DebtEntry[]; today: string;
  onSave: (change: DebtChange) => Promise<void>; onBack: () => void;
}) {
  const { previous, seed, type, voiding } = draft;
  const [pair, setPair] = useState<Pair>(previous ?? seed?.pair ?? { payerId: '' as PersonId, recipientId: '' as PersonId });
  const [amount, setAmount] = useState(previous?.amountYen.toString() ?? '');
  const [date, setDate] = useState(previous?.transactionDate ?? seed?.matchSnapshot.date ?? today);
  const [memo, setMemo] = useState(previous?.memo ?? '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const amountYen = Number(amount);
  const selected = validPair(pair);
  const current = selected ? balanceFor(entries, pair) : 0;
  const available = selected ? balanceFor(entries.filter(entry => entry.entryId !== previous?.entryId), pair) : 0;
  const exceeds = type === 'payment' && amountYen > available;
  const matchSnapshot = previous?.matchSnapshot ?? seed?.matchSnapshot ?? null;
  const title = voiding ? '取引を取り消す' : previous ? typeName(type) + 'を変更' : typeName(type) + 'を記録';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError('');
    setSaving(true);
    const fields = { payerId: pair.payerId, recipientId: pair.recipientId, type, amountYen, transactionDate: date, memo, matchSnapshot };
    const change: DebtChange = previous
      ? voiding ? { action: 'void', previous, reason } : { action: 'update', previous, fields, reason }
      : { action: 'create', fields };
    try {
      await onSave(change);
    } catch (failure) {
      setError(failure instanceof DebtError ? failure.message : '保存に失敗しました。接続やアクセス権限を確認してください。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={panel + ' mx-auto max-w-3xl'} onSubmit={submit}>
      <h2 className="text-xl font-bold">{title}</h2>
      <fieldset disabled={saving} className="min-w-0 space-y-3">
        {voiding ? <p className="break-words">{previous && pairName(previous)} の取引を取り消します。履歴は残ります。</p> : <>
          <PairFields value={pair} onChange={setPair} />
          {type === 'payment' && selected && <div className="break-words rounded-lg bg-blue-50 p-2">
            <p>現在の借金：{yen(current)}</p>
            <p>支払い後：{amount && !exceeds && amountYen > 0 ? yen(available - amountYen) : '—'}</p>
            {available === 0 ? <p className="text-red-700">支払い可能な残高がありません。</p>
              : exceeds && <p className="text-red-700">残高を超える支払いは登録できません。</p>}
          </div>}
          <label className="block">金額（円）
            <input className={field} type="number" inputMode="numeric" min="1" step="1" required value={amount} onChange={event => setAmount(event.target.value)} />
          </label>
          <label className="block">取引日
            <input className={field} type="date" max={today} required value={date} onChange={event => setDate(event.target.value)} />
          </label>
          <label className="block">メモ
            <textarea className={field} value={memo} onChange={event => setMemo(event.target.value)} />
          </label>
          {matchSnapshot && <MatchInfo snapshot={matchSnapshot} />}
        </>}
        {previous && <label className="block">{voiding ? '取消理由' : '変更理由'}
          <textarea className={field} required value={reason} onChange={event => setReason(event.target.value)} />
        </label>}
      </fieldset>
      {error && <p role="alert" className="break-words text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondary} onClick={onBack} disabled={saving}>戻る</button>
        <button className={button} disabled={saving || (!voiding && (!selected || exceeds)) || (!!previous && !reason.trim())}>
          {saving ? '保存中…' : voiding ? '取消を確定' : '保存する'}
        </button>
      </div>
    </form>
  );
}

function MatchInfo({ snapshot }: { snapshot: MatchSnapshot }) {
  return <div className="break-words rounded-lg bg-indigo-50 p-2 text-sm">
    <p className="font-bold">関連対戦</p>
    <p>{snapshot.date}{' '}{snapshot.title}</p>
    <p>{snapshot.playerAName} {snapshot.playerAScore} − {snapshot.playerBScore} {snapshot.playerBName}</p>
    <p>勝者：{snapshot.winnerName ?? '引き分け'}</p>
    <p className="break-all text-xs text-slate-500">Match ID：{snapshot.matchId}</p>
  </div>;
}

function EntryInfo({ entry }: { entry: DebtEntry }) {
  return <div className="space-y-1 break-words">
    <p>{entry.transactionDate}{' '}{typeName(entry.type)}{' '}{signedYen(entry)}</p>
    <p>{pairName(entry)}{' '}{entry.status === 'voided' && <strong className="text-red-700">取消済み</strong>}</p>
    <p className="whitespace-pre-wrap">メモ：{entry.memo || '—'}</p>
    {entry.changeReason && <p className="whitespace-pre-wrap">理由：{entry.changeReason}</p>}
    <p className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString('ja-JP')}{' '}{entry.createdBy}</p>
    {entry.matchSnapshot && <MatchInfo snapshot={entry.matchSnapshot} />}
  </div>;
}

function EntryDetail({ ledger, entry, sample, onDraft, onBack }: {
  ledger: LedgerRef; entry: DebtEntry; sample: DebtEntry[]; onDraft: (draft: Draft) => void; onBack: () => void;
}) {
  const [revisions, setRevisions] = useState<DebtEntry[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (ledger) return watchRevisions(ledger, entry.entryId, setRevisions, () => setError(true));
  }, [ledger, entry.entryId]);
  const history = ledger ? revisions : sample.filter(revision => revision.entryId === entry.entryId);
  const actions = { create: '登録', update: '変更', void: '取消' };
  return <>
    <button className={secondary} onClick={onBack}>台帳に戻る</button>
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <section className={panel}>
        <h2 className="text-xl font-bold">取引詳細</h2>
        <h3 className="font-bold">現在値 · v{entry.revision}</h3>
        <EntryInfo entry={entry} />
        {entry.status === 'active' && <div className="flex gap-2">
          <button className={button} onClick={() => onDraft({ type: entry.type, previous: entry })}>編集</button>
          <button className={secondary} onClick={() => onDraft({ type: entry.type, previous: entry, voiding: true })}>取消</button>
        </div>}
      </section>
      <section className={panel}>
        <h3 className="font-bold">revision履歴</h3>
        {error ? <p role="alert">revision履歴を取得できませんでした。</p>
          : history === null ? <p>読込中…</p>
            : [...history].sort((a, b) => a.revision - b.revision).map(revision => (
              <article key={revision.revision} className="space-y-1 border-t border-slate-200 pt-3">
                <h4 className="font-bold">v{revision.revision} · {actions[revision.action]}</h4>
                <EntryInfo entry={revision} />
              </article>
            ))}
      </section>
    </div>
  </>;
}

function BalanceChart({ pair, balance, entries, period, today }: {
  pair: Pair; balance: number; entries: DebtEntry[]; period: Period; today: string;
}) {
  const points = graphPoints(entries, pair, period, today);
  const opening = points[0]?.entry === null ? points[0] : undefined;
  const chartData = points.map(point => ({
    tick: point.entry ? point.date : '期首',
    balance: point.balance,
    label: point.date + (point.entry ? ' 終値' : ' 期首残高'),
  }));

  return <article className="min-w-0 space-y-2 rounded-lg border border-slate-200 p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
      <h3 className="font-bold">{pairName(pair)}</h3>
      <strong className={balance > 0 ? 'text-blue-700' : 'text-slate-600'}>
        {balance > 0 ? '現在 ' + yen(balance) : '完済'}
      </strong>
    </div>
    {opening && <p className="text-sm">期首残高：{yen(opening.balance)}</p>}
    {chartData.length === 0 ? <p className="text-sm">この期間の取引データはありません</p> :
      <div className="h-56 min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 280, height: 224 }}>
          <LineChart data={chartData} margin={{ right: 12, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="tick" tickFormatter={date => date === '期首' ? date : date.slice(5)} tick={{ fontSize: 11 }} />
            <YAxis width={60} tick={{ fontSize: 10 }} allowDecimals={false}
              tickFormatter={amount => new Intl.NumberFormat('ja-JP', { notation: 'compact' }).format(amount)} />
            <Tooltip formatter={amount => [yen(Number(amount)), '借金残高']} labelFormatter={(_, items) => items[0]?.payload.label}
              contentStyle={{ fontSize: 12 }} />
            <Line dataKey="balance" name="借金残高（円）" stroke="#2563eb" strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>}
  </article>;
}

const historyColumns = 'md:grid md:grid-cols-[1fr_0.8fr_1fr_1fr_1.4fr_0.8fr] md:items-center md:gap-3';

function TransactionHistory({ entries, onSelect }: { entries: DebtEntry[]; onSelect: (entryId: string) => void }) {
  return <section className={panel}>
    <h2 className="text-xl font-bold">取引履歴</h2>
    {entries.length === 0 ? <p>取引はありません</p> : <>
      <div aria-hidden="true" className={historyColumns + ' hidden px-2 text-sm font-bold text-slate-600'}>
        <span>日付</span><span>種類</span><span>借りている人</span><span>相手</span>
        <span className="text-right">金額</span><span>状態</span>
      </div>
      {[...entries].sort((a, b) => compareEntries(b, a)).map(entry => (
        <button key={entry.entryId} className={historyColumns + ' block w-full break-words rounded-lg bg-slate-50 p-2 text-left'}
          onClick={() => onSelect(entry.entryId)}>
          <span>{entry.transactionDate}</span>{' '}
          <span>{typeName(entry.type)}</span>{' '}
          <strong className="md:col-start-5 md:row-start-1 md:text-right">{signedYen(entry)}</strong>
          <span className="block text-sm md:contents">
            <span>{people[entry.payerId]}</span><span className="md:hidden"> → </span><span>{people[entry.recipientId]}</span>{' '}
            {entry.status === 'voided' ? <strong className="text-red-700">取消済み</strong> : <span className="hidden md:inline">有効</span>}
          </span>
        </button>
      ))}
    </>}
  </section>;
}

export function DebtLedgerView({ ledger, actor, seed, today, onExit }: {
  ledger: LedgerRef; actor: string; seed: AwardSeed | null; today: string; onExit: () => void;
}) {
  const [rawEntries, setEntries] = useState<DebtEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [period, setPeriod] = useState<Period>('all');
  const [entryId, setEntryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(seed && { type: 'award', seed });
  useEffect(() => watchEntries(ledger, setEntries, () => setLoadError(true)), [ledger]);

  const entries = latestEntries(rawEntries ?? []);
  const selectedEntry = entries.find(entry => entry.entryId === entryId);
  const chartPairs = graphPairs(entries);
  const balances = chartPairs.filter(row => row.balance > 0);

  async function save(change: DebtChange) {
    const next = await saveDebtChange(ledger, change, actor, setEntries);
    setEntries(current => {
      const existing = current ?? [];
      if (!ledger || existing.some(entry => entry.entryId === next.entryId && entry.revision >= next.revision)) return current;
      return [...existing.filter(entry => entry.entryId !== next.entryId), next];
    });
    setEntryId(next.entryId);
    setDraft(null);
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-50">
      <header className="flex flex-wrap items-center gap-3 bg-blue-600 p-4 text-white">
        <button className="rounded-lg bg-white/20 px-3 py-2" onClick={onExit}>{seed ? '対戦結果' : 'ホーム'}</button>
        <h1 className="text-xl font-bold">賞金・借金台帳</h1>
      </header>
      {!ledger && <p className="bg-amber-50 p-2 text-center text-sm font-bold text-amber-900">サンプルモード・この端末のみ</p>}
      <main className="space-y-4 p-4">
        {loadError ? <p role="alert">台帳を取得できませんでした。接続やアクセス権限を確認してください。</p>
          : !rawEntries ? <p>読込中…</p>
            : draft ? <EntryForm draft={draft} entries={entries} today={today} onSave={save} onBack={() => setDraft(null)} />
              : selectedEntry ? <EntryDetail key={selectedEntry.entryId} ledger={ledger} entry={selectedEntry} sample={rawEntries}
                onDraft={setDraft} onBack={() => setEntryId(null)} />
                : <>
                  <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <section className={panel}>
                      <h2 className="text-xl font-bold">現在の借金</h2>
                      {balances.length === 0 ? <p>現在の借金はありません</p> :
                        <ul className="space-y-2">
                          {balances.map(({ pair, balance }) => (
                            <li key={pairName(pair)} className="flex flex-wrap items-center justify-between gap-1 rounded-lg bg-blue-50 p-2">
                              <span>{pairName(pair)}</span><strong>{yen(balance)}</strong>
                            </li>
                          ))}
                        </ul>}
                      <div className="flex flex-wrap gap-2">
                        <button className={button} onClick={() => setDraft({ type: 'award' })}>賞金を記録</button>
                        <button className={button} onClick={() => setDraft({ type: 'payment' })}>支払いを記録</button>
                      </div>
                    </section>
                    <section className={panel}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-xl font-bold">借金残高の推移</h2>
                        <div className="grid grid-cols-3 gap-1" role="group" aria-label="グラフの表示期間">
                          {(Object.keys(periods) as Period[]).map(value => (
                            <button key={value} className={value === period ? button : secondary} aria-pressed={value === period}
                              onClick={() => setPeriod(value)}>{periods[value]}</button>
                          ))}
                        </div>
                      </div>
                      {chartPairs.length === 0 ? <p>取引データはありません</p> :
                        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                          {chartPairs.map(({ pair, balance }) => (
                            <BalanceChart key={pairName(pair)} pair={pair} balance={balance} entries={entries} period={period} today={today} />
                          ))}
                        </div>}
                    </section>
                  </div>
                  <TransactionHistory entries={entries} onSelect={setEntryId} />
                </>}
      </main>
    </div>
  );
}
