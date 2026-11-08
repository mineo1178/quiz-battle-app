import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimRoundResult, confirmRound, createBattleState, createMatch, getEffectiveTimeLimit, parseSavedBattleState,
} from '../src/battleLogic.ts';

const playerA = { id: 'a', name: 'Player A', handicap: 'none' };
const playerB = { id: 'b', name: 'Player B', handicap: 'none' };
const primary = { ...playerA, handicap: 'primary' };
const junior = { ...playerB, handicap: 'junior' };
const custom = { ...playerB, handicap: 'custom', customScoreOffset: '-2', customTimeOffset: '7' };
const setup = {
  date: '2026-11-08',
  title: 'Quiz battle',
  category: '理科',
  timeLimitSec: 30,
  players: { playerAId: playerA.id, playerBId: playerB.id },
  questioner: 'A',
  startTime: '2026-11-08T01:00:00.000Z',
};
const startBattle = (questioner = 'A') => createBattleState({ ...setup, questioner }, playerA, playerB);

test('initial scores preserve no handicap, primary +3 and numeric custom offsets', () => {
  assert.deepEqual(startBattle().scores, { playerA: 0, playerB: 0 });
  assert.deepEqual(createBattleState(setup, primary, junior).scores, { playerA: 3, playerB: 0 });
  assert.deepEqual(createBattleState(setup, playerA, custom).scores, { playerA: 0, playerB: -2 });
  assert.deepEqual(createBattleState(setup, playerA, { ...custom, customScoreOffset: '3' }).scores, {
    playerA: 0, playerB: 3,
  });
});

test('only junior and custom answerers change the time limit, with a five-second minimum', () => {
  assert.equal(getEffectiveTimeLimit(30, playerA), 30);
  assert.equal(getEffectiveTimeLimit(30, primary), 30);
  assert.equal(getEffectiveTimeLimit(30, junior), 25);
  assert.equal(getEffectiveTimeLimit(8, junior), 5);
  assert.equal(getEffectiveTimeLimit(30, custom), 37);
  assert.equal(getEffectiveTimeLimit(10, { ...custom, customTimeOffset: '-8' }), 5);
  assert.equal(getEffectiveTimeLimit(undefined, undefined), 30);
});

for (const [result, winnerWhenAAsks, winnerWhenBAsks] of [
  ['correct', playerB, playerA],
  ['incorrect', playerA, playerB],
  ['timeout', playerA, playerB],
]) {
  test(`${result} awards exactly one point and swaps roles for either questioner`, () => {
    for (const [questioner, nextQuestioner, asker, answerer, winner] of [
      ['A', 'B', playerA, playerB, winnerWhenAAsks],
      ['B', 'A', playerB, playerA, winnerWhenBAsks],
    ]) {
      const before = startBattle(questioner);
      const elapsedSec = result === 'timeout' ? 30 : 4;
      const confirmed = confirmRound('confirming', before, result, playerA, playerB, elapsedSec);
      assert.equal(confirmed.phase, 'idle');
      assert.deepEqual(confirmed.battleState, {
        ...before,
        scores: winner === playerA ? { playerA: 1, playerB: 0 } : { playerA: 0, playerB: 1 },
        rounds: [{
          roundNo: 1, questionerId: asker.id, answererId: answerer.id,
          result, pointPlayerId: winner.id, elapsedSec,
        }],
        currentRound: 2,
        questioner: nextQuestioner,
      });
      assert.deepEqual(before.scores, { playerA: 0, playerB: 0 });
      assert.deepEqual(before.rounds, []);
    }
  });
}

test('the first answer or timeout claims the round and confirmation cannot record it twice', () => {
  for (const [first, second] of [
    ['correct', 'timeout'], ['timeout', 'correct'],
    ['incorrect', 'timeout'], ['timeout', 'incorrect'],
  ]) {
    let phase = 'running';
    let pendingResult = null;
    for (const candidate of [first, second]) {
      const claimed = claimRoundResult(phase);
      if (claimed) {
        phase = claimed;
        pendingResult = candidate;
      }
    }
    assert.equal(pendingResult, first);
    const confirmed = confirmRound(phase, startBattle(), pendingResult, playerA, playerB, 30);
    const { battleState } = confirmed;
    assert.equal(battleState.rounds.length, 1);
    assert.equal(battleState.rounds[0].result, first);
    assert.equal(battleState.currentRound, 2);
    assert.equal(claimRoundResult(confirmed.phase), null);
    assert.equal(confirmRound(confirmed.phase, battleState, pendingResult, playerA, playerB, 30), null);
  }
});

for (const [label, outcomes, finalScore, winnerId, result] of [
  ['A wins', ['incorrect', 'correct'], { playerA: 5, playerB: 0 }, playerA.id, 'playerA_win'],
  ['B wins', ['correct', 'incorrect', 'correct', 'incorrect'], { playerA: 3, playerB: 4 }, playerB.id, 'playerB_win'],
  ['draw', ['correct', 'incorrect', 'correct'], { playerA: 3, playerB: 3 }, null, 'draw'],
]) {
  test(`the completed Match preserves scores, rounds and handicap snapshots when ${label}`, () => {
    let battle = createBattleState(setup, primary, junior);
    for (const outcome of outcomes) {
      battle = confirmRound('confirming', battle, outcome, primary, junior, 4).battleState;
    }
    const metadata = { id: 'match_1', createdAt: setup.startTime, updatedAt: setup.startTime };
    assert.deepEqual(createMatch(battle, primary, junior, '  note  ', metadata), {
      ...metadata,
      date: setup.date,
      title: setup.title,
      category: setup.category,
      players: setup.players,
      finalScore,
      winnerId,
      result,
      questionCount: outcomes.length,
      timeLimitSec: setup.timeLimitSec,
      rounds: battle.rounds,
      memo: 'note',
      handicapSnapshot: { playerA: '小学生(初期+3)', playerB: '中学生(回答-5秒)' },
    });
  });
}

test('a serialized mid-battle state restores and continues from the saved round', () => {
  const initial = startBattle('B');
  assert.deepEqual(initial, {
    ...setup, questioner: 'B', scores: { playerA: 0, playerB: 0 }, rounds: [], currentRound: 1,
  });
  const first = confirmRound('confirming', initial, 'correct', playerA, playerB, 4).battleState;
  const restored = parseSavedBattleState(JSON.stringify(first));
  assert.deepEqual(restored, first);
  const continued = confirmRound('confirming', restored, 'timeout', playerA, playerB, 30).battleState;
  assert.deepEqual(continued.scores, { playerA: 2, playerB: 0 });
  assert.equal(continued.currentRound, 3);
  assert.equal(continued.questioner, 'B');
  assert.deepEqual(continued.rounds.map(round => [round.roundNo, round.result]), [[1, 'correct'], [2, 'timeout']]);
  assert.equal(parseSavedBattleState('broken JSON'), undefined);
  assert.equal(parseSavedBattleState(null), null);
});
