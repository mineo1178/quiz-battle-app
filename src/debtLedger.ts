import type { Match, Player } from './battleLogic';

export const people = {
  father: 'お父さん',
  mother: 'お母さん',
  taichi: 'たいち',
  yuuka: 'ゆうか',
} as const;

export type PersonId = keyof typeof people;
export type DebtType = 'award' | 'payment';
export type Period = 'all' | 'year' | 'month';
export type Pair = { payerId: PersonId; recipientId: PersonId };
export const personIds = Object.keys(people) as PersonId[];
export const pairs = personIds.flatMap(payerId =>
  personIds.filter(id => id !== payerId).map(recipientId => ({ payerId, recipientId })),
);
export const samePair = (a: Pair, b: Pair) => a.payerId === b.payerId && a.recipientId === b.recipientId;
export const validPair = (pair: Pair) => pairs.some(candidate => samePair(pair, candidate));

export interface MatchSnapshot {
  matchId: string;
  date: string;
  title: string;
  playerAName: string;
  playerBName: string;
  playerAScore: number;
  playerBScore: number;
  winnerName: string | null;
}

export function matchAward(match: Match, players: Player[]) {
  const playerA = players.find(player => player.id === match.players.playerAId);
  const playerB = players.find(player => player.id === match.players.playerBId);
  const winner = match.result === 'draw' ? undefined : match.result === 'playerA_win' ? playerA : playerB;
  const loser = winner === playerA ? playerB : playerA;
  const uniquePerson = (player?: Player) => {
    if (!player || players.filter(other => other.name === player.name).length !== 1) return;
    return personIds.find(id => people[id] === player.name);
  };
  const payerId = uniquePerson(loser);
  const recipientId = uniquePerson(winner);
  const matchSnapshot: MatchSnapshot = {
    matchId: match.id,
    date: match.date,
    title: match.title,
    playerAName: playerA?.name ?? '不明',
    playerBName: playerB?.name ?? '不明',
    playerAScore: match.finalScore.playerA,
    playerBScore: match.finalScore.playerB,
    winnerName: winner?.name ?? (match.result === 'draw' ? null : '不明'),
  };
  return {
    matchSnapshot,
    pair: payerId && recipientId && payerId !== recipientId ? { payerId, recipientId } : undefined,
  };
}

export interface DebtFields extends Pair {
  type: DebtType;
  amountYen: number;
  transactionDate: string;
  memo: string;
  matchSnapshot: MatchSnapshot | null;
}

export interface DebtEntry extends DebtFields {
  entryId: string;
  revision: number;
  status: 'active' | 'voided';
  action: 'create' | 'update' | 'void';
  previousRevision: number | null;
  changeReason: string;
  registeredAt: number;
  createdAt: number;
  createdBy: string;
}

export type DebtChange =
  | { action: 'create'; fields: DebtFields }
  | { action: 'update'; previous: DebtEntry; fields: DebtFields; reason: string }
  | { action: 'void'; previous: DebtEntry; reason: string };

export class DebtError extends Error {}

export const signedAmount = (entry: DebtFields) => entry.type === 'award' ? entry.amountYen : -entry.amountYen;

export function compareEntries(a: DebtEntry, b: DebtEntry) {
  return a.transactionDate.localeCompare(b.transactionDate)
    || a.registeredAt - b.registeredAt
    || a.entryId.localeCompare(b.entryId);
}

export function latestEntries(entries: DebtEntry[]) {
  const latest = new Map<string, DebtEntry>();
  for (const entry of entries) {
    if ((latest.get(entry.entryId)?.revision ?? 0) < entry.revision) latest.set(entry.entryId, entry);
  }
  return [...latest.values()];
}

export function timeline(entries: DebtEntry[], pair: Pair) {
  let balance = 0;
  return latestEntries(entries)
    .filter(entry => entry.status === 'active' && samePair(entry, pair))
    .sort(compareEntries)
    .map(entry => ({ entry, date: entry.transactionDate, balance: balance += signedAmount(entry) }));
}

export const balanceFor = (entries: DebtEntry[], pair: Pair) => timeline(entries, pair).at(-1)?.balance ?? 0;

export function graphPoints(entries: DebtEntry[], pair: Pair, period: Period, today: string) {
  const points = timeline(entries, pair);
  if (period === 'all') return points;
  const prefix = today.slice(0, period === 'year' ? 4 : 7);
  const start = period === 'year' ? prefix + '-01-01' : prefix + '-01';
  const opening = points.findLast(point => point.date < start);
  const within = points.filter(point => point.date.startsWith(prefix));
  if (!opening && !within.length) return [];
  return [{ date: start, balance: opening?.balance ?? 0, entry: null }, ...within];
}

export function prepareRevision(
  entries: DebtEntry[], entryId: string, change: DebtChange, now: number, actor: string,
): DebtEntry {
  const latest = latestEntries(entries);
  const previous = latest.find(entry => entry.entryId === entryId);
  if (change.action === 'create' ? previous : !previous || previous.revision !== change.previous.revision || previous.status !== 'active') {
    throw new DebtError('取引が更新されています。最新の内容を開き直してください。');
  }

  const fields = change.action === 'void' ? previous! : change.fields;
  const { type, payerId, recipientId, amountYen, transactionDate, memo } = fields;
  if (type !== 'award' && type !== 'payment') throw new DebtError('取引の種類が無効です。');
  if (!validPair(fields)) throw new DebtError('異なる2人を選択してください。');
  if (!Number.isSafeInteger(amountYen) || amountYen < 1) throw new DebtError('金額は1円以上の整数を入力してください。');
  const date = new Date(transactionDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== transactionDate) {
    throw new DebtError('有効な取引日を入力してください。');
  }
  const changeReason = change.action === 'create' ? '' : change.reason.trim();
  if (change.action !== 'create' && !changeReason) throw new DebtError('理由を入力してください。');
  if (previous && type !== previous.type) throw new DebtError('取引の種類は変更できません。');
  const next: DebtEntry = {
    type, payerId, recipientId, amountYen, transactionDate, memo,
    matchSnapshot: previous ? previous.matchSnapshot : fields.matchSnapshot,
    entryId,
    revision: (previous?.revision ?? 0) + 1,
    status: change.action === 'void' ? 'voided' : 'active',
    action: change.action,
    previousRevision: previous?.revision ?? null,
    changeReason,
    registeredAt: previous?.registeredAt ?? latest.reduce((time, entry) => Math.max(time, entry.registeredAt + 1), now),
    createdAt: Math.max(now, (previous?.createdAt ?? 0) + 1),
    createdBy: actor,
  };
  const updated = [...latest.filter(entry => entry.entryId !== entryId), next];
  const affected = previous && !samePair(previous, next) ? [previous, next] : [next];
  for (const pair of affected) {
    for (const point of timeline(updated, pair)) {
      if (!Number.isSafeInteger(point.balance)) throw new DebtError('残高が扱える金額の上限を超えます。');
      if (point.balance < 0) {
        throw new DebtError(`${people[pair.payerId]} → ${people[pair.recipientId]} の残高が ${point.date} にマイナスになります。`);
      }
    }
  }
  return next;
}
