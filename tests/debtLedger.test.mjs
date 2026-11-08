import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  balanceFor, graphPoints, matchAward, pairs, personIds, prepareRevision, timeline, validPair,
} from '../src/debtLedger.ts';

const pair = { payerId: 'father', recipientId: 'yuuka' };
const reverse = { payerId: 'yuuka', recipientId: 'father' };
const other = { payerId: 'mother', recipientId: 'yuuka' };
const fields = (overrides = {}) => ({
  ...pair, type: 'award', amountYen: 1000, transactionDate: '2026-11-01', memo: '', matchSnapshot: null, ...overrides,
});
const create = (entries, entryId, overrides, now = 10) =>
  prepareRevision(entries, entryId, { action: 'create', fields: fields(overrides) }, now, 'tester');
const edit = (entries, previous, overrides, reason = '訂正') =>
  prepareRevision(entries, previous.entryId, { action: 'update', previous, fields: { ...previous, ...overrides }, reason }, 20, 'tester');
const voidEntry = (entries, previous, reason = '取消理由') =>
  prepareRevision(entries, previous.entryId, { action: 'void', previous, reason }, 30, 'tester');

test('固定4人の12方向を有効とし、同一人物や未知のIDを拒否する', () => {
  assert.equal(pairs.length, 12);
  for (const payerId of personIds) {
    for (const recipientId of personIds) {
      assert.equal(validPair({ payerId, recipientId }), payerId !== recipientId);
    }
  }
  assert.equal(validPair({ ...pair, payerId: 'unknown' }), false);
});

test('金額は正の安全な整数、日付は実在する日を受け付ける', () => {
  for (const amountYen of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => create([], 'a', { amountYen }), /1円以上の整数/);
  }
  assert.equal(create([], 'a', { amountYen: 1 }).amountYen, 1);
  assert.throws(() => create([], 'a', { transactionDate: '2026-02-30' }), /有効な取引日/);
});

test('複数の賞金と支払いを累積し、完済や逆方向を独立して扱う', () => {
  const entries = [];
  entries.push(create(entries, 'a'));
  entries.push(create(entries, 'b', { amountYen: 2000 }));
  entries.push(create(entries, 'c', { type: 'payment', amountYen: 500 }));
  entries.push(create(entries, 'd', { ...reverse, amountYen: 300 }));
  assert.equal(balanceFor(entries, pair), 2500);
  assert.throws(() => create(entries, 'e', { type: 'payment', amountYen: 2501 }), /マイナス/);
  entries.push(create(entries, 'e', { type: 'payment', amountYen: 2500 }));
  assert.equal(balanceFor(entries, pair), 0);
  assert.equal(balanceFor(entries, reverse), 300);
  assert.deepEqual(timeline(entries, pair).map(point => point.balance), [1000, 3000, 2500, 0]);
});

test('遡及支払いや旧・新ペアを含め、途中で残高が負になる変更・取消を拒否する', () => {
  const award = create([], 'a');
  const entries = [award];
  entries.push(create(entries, 'p', { type: 'payment', amountYen: 1000, transactionDate: '2026-11-03' }));
  entries.push(create(entries, 'b', { transactionDate: '2026-11-05' }));
  assert.equal(balanceFor(entries, pair), 1000);
  assert.throws(() => create(entries, 'q', { type: 'payment', amountYen: 1, transactionDate: '2026-10-30' }), /マイナス/);
  assert.throws(() => edit(entries, award, { amountYen: 500 }), /マイナス/);
  assert.throws(() => edit(entries, award, other), /お父さん → ゆうか/);
  assert.throws(() => edit(entries, entries[1], other), /お母さん → ゆうか/);
  assert.throws(() => voidEntry(entries, award), /マイナス/);
});

test('完全なrevisionを追加し、古い版、理由なしの変更、取消後の編集を検証する', () => {
  const v1 = create([], 'a', { memo: '元メモ' });
  assert.throws(() => edit([v1], v1, {}, '  '), /理由/);
  assert.throws(() => edit([v1], v1, { type: 'payment' }), /種類/);
  const v2 = edit([v1], v1, { amountYen: 500, memo: '新メモ' });
  assert.throws(() => edit([v1, v2], v1, {}), /更新されています/);
  assert.throws(() => voidEntry([v1, v2], v2, ''), /理由/);
  const v3 = voidEntry([v1, v2], v2);
  const history = [v1, v2, v3];
  assert.deepEqual(history.map(entry => [entry.revision, entry.action, entry.previousRevision, entry.amountYen, entry.memo]), [
    [1, 'create', null, 1000, '元メモ'], [2, 'update', 1, 500, '新メモ'], [3, 'void', 2, 500, '新メモ'],
  ]);
  assert.equal(v3.status, 'voided');
  assert.equal(balanceFor(history, pair), 0);
  assert.throws(() => edit(history, v3, {}), /更新されています/);
});

test('全期間・今年・今月を集計し、期首残高を繰り越す', () => {
  const entries = [];
  entries.push(create(entries, 'priorYear', { transactionDate: '2025-12-31' }));
  entries.push(create(entries, 'priorMonth', { transactionDate: '2026-10-31' }));
  entries.push(create(entries, 'a'));
  entries.push(create(entries, 'p', { type: 'payment', amountYen: 500 }));
  entries.push(create(entries, 'later', { transactionDate: '2026-12-01' }));
  const graph = period => graphPoints(entries.toReversed(), pair, period, '2026-11-08');
  assert.deepEqual(graph('all').map(point => point.balance), [1000, 2000, 3000, 2500, 3500]);
  assert.deepEqual(graph('year').map(point => point.balance), [1000, 2000, 3000, 2500, 3500]);
  assert.equal(graph('year')[0].date, '2026-01-01');
  assert.deepEqual(graph('month').map(point => point.balance), [2000, 3000, 2500]);
  assert.deepEqual(graph('month')[0], { date: '2026-11-01', balance: 2000, entry: null });
});

test('同日同時刻はIDで並び、遡及変更・取消後のグラフは最新版で再計算する', () => {
  const a = create([], 'a');
  const b = create([], 'b', { amountYen: 2000 });
  assert.deepEqual(timeline([b, a], pair).map(point => point.entry.entryId), ['a', 'b']);
  const changed = edit([a, b], a, { amountYen: 250 });
  const voided = voidEntry([a, b, changed], b);
  assert.deepEqual(graphPoints([b, a, voided, changed], pair, 'all', '2026-11-08').map(point => point.balance), [250]);
  assert.deepEqual(graphPoints([], pair, 'month', '2026-11-08'), []);
});

test('関連対戦の情報を独立して保存し、完全一致かつ一意の場合だけ人物を初期設定する', () => {
  const match = {
    id: 'match-1', title: '家族対戦', date: '2026-11-01', result: 'playerB_win',
    players: { playerAId: 'a', playerBId: 'b' }, finalScore: { playerA: 3, playerB: 5 },
  };
  const players = [{ id: 'a', name: 'お父さん' }, { id: 'b', name: 'ゆうか' }];
  const { matchSnapshot, pair: initial } = matchAward(match, players);
  assert.deepEqual(initial, pair);
  assert.equal(matchAward({ ...match, result: 'draw' }, players).pair, undefined);
  assert.equal(matchAward(match, [...players, { id: 'c', name: 'ゆうか' }]).pair, undefined);
  assert.equal(matchAward(match, [players[0], { ...players[1], name: 'ゆうかさん' }]).pair, undefined);
  const entry = create([], 'a', { matchSnapshot });
  match.title = '変更後の対戦名';
  players[1].name = '変更後の名前';
  assert.deepEqual(entry.matchSnapshot, {
    matchId: 'match-1', title: '家族対戦', date: '2026-11-01', playerAName: 'お父さん',
    playerBName: 'ゆうか', playerAScore: 3, playerBScore: 5, winnerName: 'ゆうか',
  });
  assert.deepEqual(edit([entry], entry, { matchSnapshot: null }).matchSnapshot, entry.matchSnapshot);
});
