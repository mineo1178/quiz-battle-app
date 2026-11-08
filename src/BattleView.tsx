import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type React from 'react';
import { Check, Clock, Loader2, Play, Undo2, Volume2, X } from 'lucide-react';
import { playBeep, playFinishSound, playStartSound } from './sound';
import { claimRoundResult, confirmRound, createMatch, getEffectiveTimeLimit } from './battleLogic';
import type { BattleState, Match, Player, Round, RoundPhase } from './battleLogic';

interface BattleProps {
  players: Player[];
  battleState: BattleState | null;
  setBattleState: (state: BattleState | null) => void;
  soundEnabled: boolean;
  setCurrentView: (view: 'result') => void;
  saveMatch: (match: Match) => Promise<boolean>;
  setFinishedMatch: (match: Match) => void;
  setErrorMsg: (msg: string) => void;
  storageKey: string;
}

export const BattleView = ({ players, battleState, setBattleState, soundEnabled, setCurrentView, saveMatch, setFinishedMatch, setErrorMsg, storageKey }: BattleProps) => {
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const timerPhase = useRef<RoundPhase>('idle');
  const [confirmDialog, setConfirmDialog] = useState<{show: boolean, result: Round['result'] | null}>({show: false, result: null});
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
  const [memoInput, setMemoInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const pA = players.find((p: Player) => p.id === battleState?.players.playerAId);
  const pB = players.find((p: Player) => p.id === battleState?.players.playerBId);

  const isQuestionerA = battleState?.questioner === 'A';
  const qPlayer = isQuestionerA ? pA : pB;
  const aPlayer = isQuestionerA ? pB : pA;

  const effectiveTimeLimit = useMemo(
    () => getEffectiveTimeLimit(battleState?.timeLimitSec, aPlayer),
    [battleState?.timeLimitSec, aPlayer],
  );

  const showRoundResult = useCallback((result: Round['result']) => {
    const claimedPhase = claimRoundResult(timerPhase.current);
    if (!claimedPhase) return false;
    timerPhase.current = claimedPhase;
    setIsTimerRunning(false);
    setConfirmDialog({show: true, result});
    return true;
  }, []);

  const [timeLeft, setTimeLeft] = useState(effectiveTimeLimit);
  const round = battleState?.currentRound;
  const [timerResetInputs, setTimerResetInputs] = useState({ effectiveTimeLimit, round, showFinishConfirm });

  // Reset only when the round, limit or finish dialog changes.
  if (timerResetInputs.effectiveTimeLimit !== effectiveTimeLimit ||
      timerResetInputs.round !== round ||
      timerResetInputs.showFinishConfirm !== showFinishConfirm) {
    setTimerResetInputs({ effectiveTimeLimit, round, showFinishConfirm });
    if (!isTimerRunning && !confirmDialog.show && !showFinishConfirm) {
      setTimeLeft(effectiveTimeLimit);
    }
  }

  useEffect(() => {
    if (!isTimerRunning || confirmDialog.show || showFinishConfirm) return;

    const timerId = setTimeout(() => {
      if (timerPhase.current !== 'running') return;
      if (timeLeft <= 1) {
        if (!showRoundResult('timeout')) return;
        setTimeLeft(timeLeft - 1);
        if (soundEnabled) {
          void playBeep(220, 0.8, 'sawtooth', 0.8);
        }
        return;
      }

      setTimeLeft((prev: number) => {
        const next = prev - 1;
        if (soundEnabled && next > 0) {
          void playBeep(900, 0.04, 'square', 0.35);
        }
        return next;
      });
    }, 1000);

    return () => clearTimeout(timerId);
  }, [isTimerRunning, timeLeft, confirmDialog.show, showFinishConfirm, soundEnabled, showRoundResult]);

  if (!battleState) return null;

  const confirmResult = () => {
    const confirmed = confirmRound(
      timerPhase.current, battleState, confirmDialog.result, pA, pB, effectiveTimeLimit - timeLeft,
    );
    if (!confirmed) return;

    timerPhase.current = confirmed.phase;
    const newState = confirmed.battleState;
    setBattleState(newState);
    localStorage.setItem(storageKey, JSON.stringify(newState));
    setConfirmDialog({show: false, result: null});
  };

  const undoLastRound = () => {
    if (battleState.rounds.length === 0) return;
    if (!window.confirm("直前の回答を取り消しますか？")) return;

    const lastRound = battleState.rounds[battleState.rounds.length - 1];
    const newScores = { ...battleState.scores };

    if (lastRound.pointPlayerId === pA?.id) newScores.playerA -= 1;
    else if (lastRound.pointPlayerId === pB?.id) newScores.playerB -= 1;

    const newRounds = battleState.rounds.slice(0, -1);

    const newState: BattleState = {
      ...battleState,
      scores: newScores,
      rounds: newRounds,
      currentRound: battleState.currentRound - 1,
      questioner: lastRound.questionerId === pA?.id ? 'A' : 'B'
    };

    setBattleState(newState);
    localStorage.setItem(storageKey, JSON.stringify(newState));
  };

  const requestFinish = () => {
    if (timerPhase.current === 'confirming') return;
    if (battleState.currentRound === 1) {
      setErrorMsg("まだ1問も完了していません。対戦を行ってから終了してください。");
      return;
    }
    timerPhase.current = 'idle';
    setIsTimerRunning(false);
    setShowFinishConfirm(true);
  };

  const executeFinish = async (event: React.MouseEvent<HTMLButtonElement>) => {
    setIsSaving(true);
    const matchData = createMatch(battleState, pA, pB, memoInput, {
      id: 'match_' + Date.now().toString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (soundEnabled) {
      void playFinishSound(event.nativeEvent);
    }

    const success = await saveMatch(matchData);
    setIsSaving(false);

    if (success) {
      setShowFinishConfirm(false);
      setFinishedMatch(matchData);
      setCurrentView('result');
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 relative">
      <div className="bg-slate-900 text-slate-300 text-xs py-1.5 px-4 text-center truncate font-bold">
        {battleState.category} - {battleState.title}
      </div>

      <div className="bg-slate-800 text-white p-4 flex justify-between items-center shadow-md z-10">
        <div className="flex flex-col items-center flex-1">
          <span className="text-xs font-bold opacity-80">{pA?.name} (赤)</span>
          <span className="text-5xl font-black text-red-400">{battleState.scores.playerA}</span>
        </div>
        <div className="flex flex-col items-center px-4 border-x border-slate-600">
          <span className="text-xs text-slate-400">ラウンド</span>
          <span className="text-xl font-bold">{battleState.currentRound}</span>
        </div>
        <div className="flex flex-col items-center flex-1">
          <span className="text-xs font-bold opacity-80">{pB?.name} (青)</span>
          <span className="text-5xl font-black text-blue-400">{battleState.scores.playerB}</span>
        </div>
      </div>

      <div className="flex-1 p-4 flex flex-col gap-4 overflow-y-auto pb-32">
        <div className="flex gap-3 h-24 relative">
          <div className={`flex-1 rounded-xl border-2 p-3 shadow-sm flex flex-col justify-center ${isQuestionerA ? 'border-red-400 bg-red-50 text-red-900' : 'border-blue-400 bg-blue-50 text-blue-900'}`}>
            <span className="text-[10px] font-bold opacity-70 mb-1 flex items-center justify-center gap-1"><Volume2 className="w-3 h-3"/> 出題する人</span>
            <span className="font-black text-xl text-center truncate">{qPlayer?.name}</span>
          </div>
          <div className={`flex-1 rounded-xl border-2 p-3 shadow-sm flex flex-col justify-center ${!isQuestionerA ? 'border-red-400 bg-red-50 text-red-900' : 'border-blue-400 bg-blue-50 text-blue-900'}`}>
            <span className="text-[10px] font-bold opacity-70 mb-1 flex items-center justify-center gap-1">✍️ 答える人</span>
            <span className="font-black text-xl text-center truncate">{aPlayer?.name}</span>
          </div>
        </div>

        <div className={`mt-4 rounded-full w-48 h-48 mx-auto flex flex-col items-center justify-center border-8 transition-all duration-300 shadow-inner ${timeLeft <= 5 ? 'bg-red-100 border-red-600 scale-110 shadow-[0_0_30px_rgba(220,38,38,0.5)] animate-pulse' : 'bg-white border-slate-200'}`}>
           <span className={`text-7xl font-black ${timeLeft <= 5 ? 'text-red-600' : 'text-slate-700'}`}>
             {timeLeft}
           </span>
           <span className="text-slate-400 font-bold">秒</span>
        </div>

        <div className="flex justify-center mt-2 h-8">
          {battleState.rounds.length > 0 && !isTimerRunning && !confirmDialog.show && (
            <button onClick={undoLastRound} className="text-slate-400 text-sm font-bold flex items-center gap-1 hover:text-slate-600 transition-colors bg-white px-4 py-1.5 rounded-full border border-slate-200 shadow-sm">
              <Undo2 className="w-4 h-4" /> 1つ前の回答を取り消す
            </button>
          )}
        </div>

        {!isTimerRunning && timeLeft === effectiveTimeLimit && !confirmDialog.show && (
          <button
            onClick={event => {
              if (timerPhase.current !== 'idle') return;
              timerPhase.current = 'running';
              if (soundEnabled) {
                void playStartSound(event.nativeEvent);
              }
              setIsTimerRunning(true);
            }}
            className="mt-4 bg-slate-800 text-white font-bold text-2xl py-5 rounded-2xl shadow-xl active:scale-95 transition-transform w-full max-w-xs mx-auto flex justify-center gap-2 items-center"
          >
            <Play fill="currentColor" className="w-6 h-6" /> スタート！
          </button>
        )}

        {isTimerRunning && (
           <div className="mt-6 text-center text-slate-500 font-bold animate-bounce">
             考え中...
           </div>
        )}
      </div>

      <div className="bg-white p-4 border-t shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.1)] sticky bottom-0 z-20">
        <div className="flex gap-3 mb-4">
           <button
             disabled={!isTimerRunning}
             onClick={() => showRoundResult('incorrect')}
             className={`flex-1 py-6 rounded-2xl font-black text-2xl flex flex-col items-center gap-2 transition-all ${isTimerRunning ? 'bg-red-500 text-white shadow-[0_6px_0_#991b1b] active:translate-y-2 active:shadow-none' : 'bg-slate-200 text-slate-400'}`}
           >
             <X className="w-10 h-10 stroke-[3]" />
             不正解
           </button>
           <button
             disabled={!isTimerRunning}
             onClick={() => showRoundResult('correct')}
             className={`flex-1 py-6 rounded-2xl font-black text-2xl flex flex-col items-center gap-2 transition-all ${isTimerRunning ? 'bg-emerald-500 text-white shadow-[0_6px_0_#065f46] active:translate-y-2 active:shadow-none' : 'bg-slate-200 text-slate-400'}`}
           >
             <Check className="w-10 h-10 stroke-[3]" />
             正解
           </button>
        </div>
        <button
          onClick={requestFinish}
          className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-xl border border-slate-200 active:bg-slate-200 transition-colors"
        >
          対戦を終了する
        </button>
      </div>

      {showFinishConfirm && (
        <div className="absolute inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4">
           <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl text-center animate-in zoom-in-95 duration-200 relative">
              {isSaving && (
                <div className="absolute inset-0 bg-white/80 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-sm">
                  <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-3 drop-shadow-md" />
                  <span className="font-black text-slate-700 text-lg">保存中...</span>
                </div>
              )}
              <h3 className="text-2xl font-black mb-2 text-slate-800">対戦を終了しますか？</h3>
              <p className="text-slate-500 font-bold mb-4">現在のスコアで結果を保存します。</p>

              <div className="text-left mb-6">
                <label className="block text-sm font-bold text-slate-600 mb-1">今日の対戦メモ (任意)</label>
                <textarea
                  value={memoInput}
                  onChange={(e) => setMemoInput(e.target.value)}
                  placeholder="例: 歴史の問題で苦戦した"
                  className="w-full border border-slate-200 rounded-lg p-3 bg-slate-50 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowFinishConfirm(false)}
                  disabled={isSaving}
                  className="flex-1 py-4 bg-slate-100 text-slate-600 font-bold text-lg rounded-xl active:bg-slate-200 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={executeFinish}
                  disabled={isSaving}
                  className="flex-1 py-4 bg-blue-600 text-white font-bold text-lg rounded-xl active:bg-blue-700 shadow-md transition-colors"
                >
                  終了して保存
                </button>
              </div>
           </div>
        </div>
      )}

      {confirmDialog.show && (
        <div className={`absolute inset-0 z-50 flex flex-col items-center justify-center p-6 transition-all duration-300 ${confirmDialog.result === 'correct' ? 'bg-emerald-500' : confirmDialog.result === 'incorrect' ? 'bg-red-500' : 'bg-amber-500'}`}>
          {confirmDialog.result === 'correct' && <Check className="w-40 h-40 text-white mx-auto mb-4 drop-shadow-lg" />}
          {confirmDialog.result === 'incorrect' && <X className="w-40 h-40 text-white mx-auto mb-4 drop-shadow-lg" />}
          {confirmDialog.result === 'timeout' && <Clock className="w-40 h-40 text-white mx-auto mb-4 drop-shadow-lg" />}

          <h3 className="text-5xl font-black text-white mb-2 drop-shadow-md">
            {confirmDialog.result === 'correct' ? '正解！' : confirmDialog.result === 'incorrect' ? '不正解...' : '時間切れ！'}
          </h3>
          <p className="text-2xl font-bold text-white mt-4 bg-black/20 px-6 py-2 rounded-full">
            得点ゲット: {confirmDialog.result === 'correct' ? aPlayer?.name : qPlayer?.name}
          </p>

          <div className="mt-12 w-full flex flex-col gap-4 max-w-xs">
            <button
              onClick={confirmResult}
              className="w-full py-5 bg-white text-slate-800 font-black rounded-2xl shadow-xl text-2xl active:scale-95 transition-transform"
            >
              次へ
            </button>
            <button
              onClick={() => {
                if (timerPhase.current !== 'confirming') return;
                const retry = confirmDialog.result !== 'timeout';
                timerPhase.current = retry ? 'running' : 'idle';
                setConfirmDialog({show: false, result: null});
                if (retry) setIsTimerRunning(true);
              }}
              className="w-full py-4 bg-transparent border-2 border-white/50 text-white font-bold rounded-2xl active:bg-white/10 transition-colors text-lg"
            >
              やり直す
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
