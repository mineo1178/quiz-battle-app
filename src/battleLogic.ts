type PlayerHandicap = 'none' | 'primary' | 'junior' | 'custom';

export interface Player {
  id: string;
  name: string;
  handicap: PlayerHandicap;
  customScoreOffset?: number | string;
  customTimeOffset?: number | string;
  isActive?: boolean;
}

export interface Round {
  roundNo: number;
  questionerId: string;
  answererId: string;
  result: 'correct' | 'incorrect' | 'timeout';
  pointPlayerId: string;
  elapsedSec: number;
}

export interface Match {
  id: string;
  date: string;
  title: string;
  category: string;
  players: {
    playerAId: string;
    playerBId: string;
  };
  finalScore: {
    playerA: number;
    playerB: number;
  };
  winnerId: string | null;
  result: 'playerA_win' | 'playerB_win' | 'draw';
  questionCount: number;
  timeLimitSec: number;
  rounds: Round[];
  memo: string;
  createdAt: string;
  updatedAt: string;
  handicapSnapshot?: {
    playerA: string;
    playerB: string;
  };
}

export interface BattleState {
  date: string;
  title: string;
  category: string;
  timeLimitSec: number;
  players: { playerAId: string; playerBId: string };
  scores: { playerA: number; playerB: number };
  rounds: Round[];
  currentRound: number;
  questioner: 'A' | 'B';
  startTime: string;
}

export const getHandicapDisplay = (p: Player | undefined) => {
  if (!p) return '';
  if (p.handicap === 'primary') return '小学生(初期+3)';
  if (p.handicap === 'junior') return '中学生(回答-5秒)';
  if (p.handicap === 'custom') return `カスタム(+${p.customScoreOffset||0}, ${p.customTimeOffset||0}秒)`;
  return 'ハンデなし';
};

const getInitialScore = (player: Player | undefined) => {
  if (player?.handicap === 'primary') return 3;
  if (player?.handicap === 'custom') return Number(player.customScoreOffset) || 0;
  return 0;
};

export const createBattleState = (
  setup: Omit<BattleState, 'scores' | 'rounds' | 'currentRound'>,
  playerA: Player | undefined,
  playerB: Player | undefined,
): BattleState => ({
  ...setup,
  scores: { playerA: getInitialScore(playerA), playerB: getInitialScore(playerB) },
  rounds: [],
  currentRound: 1,
});

export const getEffectiveTimeLimit = (baseLimit: number | undefined, answerer: Player | undefined) => {
  const limit = baseLimit || 30;
  if (answerer?.handicap === 'junior') return Math.max(5, limit - 5);
  if (answerer?.handicap === 'custom') return Math.max(5, limit + (Number(answerer.customTimeOffset) || 0));
  return limit;
};

export type RoundPhase = 'idle' | 'running' | 'confirming';

export const claimRoundResult = (phase: RoundPhase) => phase === 'running' ? 'confirming' : null;

export const confirmRound = (
  phase: RoundPhase,
  battle: BattleState,
  result: Round['result'] | null,
  playerA: Player | undefined,
  playerB: Player | undefined,
  elapsedSec: number,
): { phase: 'idle'; battleState: BattleState } | null => {
  if (!result || phase !== 'confirming') return null;

  const questionerIsA = battle.questioner === 'A';
  const pointGoesToA = result === 'correct' ? !questionerIsA : questionerIsA;
  const scores = { ...battle.scores };
  scores[pointGoesToA ? 'playerA' : 'playerB'] += 1;

  const round: Round = {
    roundNo: battle.currentRound,
    questionerId: (questionerIsA ? playerA : playerB)?.id || '',
    answererId: (questionerIsA ? playerB : playerA)?.id || '',
    result,
    pointPlayerId: (pointGoesToA ? playerA : playerB)?.id || '',
    elapsedSec,
  };

  return {
    phase: 'idle',
    battleState: {
      ...battle,
      scores,
      rounds: [...battle.rounds, round],
      currentRound: battle.currentRound + 1,
      questioner: questionerIsA ? 'B' : 'A',
    },
  };
};

export const createMatch = (
  battle: BattleState,
  playerA: Player | undefined,
  playerB: Player | undefined,
  memo: string,
  { id, createdAt, updatedAt }: Pick<Match, 'id' | 'createdAt' | 'updatedAt'>,
): Match => {
  const finalA = battle.scores.playerA;
  const finalB = battle.scores.playerB;
  let winnerId: Match['winnerId'] = null;
  let result: Match['result'] = 'draw';
  if (finalA > finalB) {
    winnerId = playerA?.id || null;
    result = 'playerA_win';
  } else if (finalB > finalA) {
    winnerId = playerB?.id || null;
    result = 'playerB_win';
  }

  return {
    id,
    date: battle.date,
    title: battle.title,
    category: battle.category,
    players: battle.players,
    finalScore: battle.scores,
    winnerId,
    result,
    questionCount: battle.currentRound - 1,
    timeLimitSec: battle.timeLimitSec,
    rounds: battle.rounds,
    memo: memo.trim(),
    createdAt,
    updatedAt,
    handicapSnapshot: {
      playerA: getHandicapDisplay(playerA),
      playerB: getHandicapDisplay(playerB),
    },
  };
};

export const parseSavedBattleState = (saved: string | null): BattleState | null | undefined => {
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return undefined;
  }
};
