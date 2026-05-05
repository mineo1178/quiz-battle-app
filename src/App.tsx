import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword } from 'firebase/auth';
import type { User as FirebaseAuthUser } from 'firebase/auth';
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { 
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, 
  PieChart, Pie, Cell, BarChart, Bar, Legend 
} from 'recharts';
import { 
  Play, History, BarChart2, Settings, Plus, Check, X, AlertCircle, 
  Clock, Trophy, Award, User, Volume2, VolumeX, Trash2, ArrowRight, RefreshCw, Zap,
  ChevronLeft, Loader2, Undo2, LogOut, Edit2
} from 'lucide-react';

// --- Types ---
type PlayerHandicap = 'none' | 'primary' | 'junior' | 'custom';

interface Player {
  id: string;
  name: string;
  handicap: PlayerHandicap;
  customScoreOffset?: number;
  customTimeOffset?: number;
  isActive?: boolean; // 論理削除用フラグ
}

interface Round {
  roundNo: number;
  questionerId: string;
  answererId: string;
  result: 'correct' | 'incorrect' | 'timeout';
  pointPlayerId: string;
  elapsedSec: number;
}

interface Match {
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

interface BattleState {
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

// --- View Props Interfaces ---
interface BaseProps {
  setCurrentView: (view: any) => void;
  setErrorMsg: (msg: string) => void;
}

interface HomeProps extends BaseProps {
  battleState: BattleState | null;
  setBattleState: (state: BattleState | null) => void;
  isSampleMode: boolean;
  setIsSampleMode: (val: boolean) => void;
}

// --- Firebase Initialization ---
// React + Vite + Vercel 用。環境変数は import.meta.env のみを使用。
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- Constants ---
const FAMILY_ID = 'oomine-study-2026';
const CATEGORIES = ['新聞', '日本史', '世界史', '地理', '小説', '理科', 'その他'];
const COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#6b7280'];
const STORAGE_KEY_STATE = 'quiz_battle_saved_state';

// --- Functions ---
const getMatchesRef = () => collection(db, 'families', FAMILY_ID, 'apps', 'quiz-battle', 'matches');
const getPlayersRef = () => collection(db, 'families', FAMILY_ID, 'apps', 'quiz-battle', 'players');

// --- Audio System (iOS / PWA Support) ---
let sharedAudioCtx: AudioContext | null = null;

const getAudioContext = (): AudioContext | null => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioContextClass();
    }
    return sharedAudioCtx;
  } catch (e) {
    console.error("AudioContext init error:", e);
    return null;
  }
};

const unlockAudio = async () => {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    // 無音の短い音を鳴らして制限を解除
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.frequency.value = 1;
    gainNode.gain.value = 0.00001;
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.01);
  } catch (e) {
    console.error("Audio unlock error:", e);
  }
};

const playBeep = (freq: number, duration: number, type: OscillatorType = "sine", volume: number = 0.5) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === "suspended") {
      ctx.resume();
    }
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.type = type;
    oscillator.frequency.value = freq;
    
    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + duration);
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
  } catch (e) {
    console.error("Audio play error:", e);
  }
};

const DEFAULT_PLAYERS: Player[] = [
  { id: 'p1', name: 'プレイヤー1', handicap: 'none', isActive: true },
  { id: 'p2', name: 'プレイヤー2', handicap: 'primary', isActive: true }
];

const getHandicapDisplay = (p: Player | undefined) => {
  if (!p) return '';
  if (p.handicap === 'primary') return '小学生(初期+3)';
  if (p.handicap === 'junior') return '中学生(回答-5秒)';
  if (p.handicap === 'custom') return `カスタム(+${p.customScoreOffset||0}, ${p.customTimeOffset||0}秒)`;
  return 'ハンデなし';
};

// --- Custom UI Components ---
const ErrorToast = ({ msg, onClose }: { msg: string, onClose: () => void }) => {
  if (!msg) return null;
  return (
    <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-4 py-3 rounded-2xl shadow-xl z-[100] flex items-center gap-3 w-11/12 max-w-sm animate-in fade-in slide-in-from-top-4">
      <AlertCircle className="w-6 h-6 shrink-0" />
      <span className="font-bold text-sm flex-1">{msg}</span>
      <button onClick={onClose} className="p-1 hover:bg-red-700 active:scale-95 rounded-full transition-all"><X className="w-5 h-5"/></button>
    </div>
  );
};

// --- View Components ---
const LoginView = ({ setIsSampleMode, setErrorMsg }: any) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch {
      setErrorMsg('ログインに失敗しました。メールアドレスとパスワードを確認してください。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 items-center justify-center p-6 relative">
      <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-sm">
        <h1 className="text-3xl font-black text-blue-600 mb-2 text-center">クイズ対戦</h1>
        <p className="text-slate-500 text-sm font-bold text-center mb-8">ログインして学習を記録しよう</p>
        
        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-bold text-slate-700 mb-1">メールアドレス</label>
            <input 
              type="email" 
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-slate-200 rounded-lg p-3 bg-slate-50 font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div className="mb-6">
            <label className="block text-sm font-bold text-slate-700 mb-1">パスワード</label>
            <input 
              type="password" 
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-slate-200 rounded-lg p-3 bg-slate-50 font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-lg p-4 rounded-xl shadow-md active:scale-95 transition-transform flex justify-center items-center gap-2"
          >
            {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : 'ログイン'}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-slate-100">
          <button 
            onClick={() => setIsSampleMode(true)}
            className="w-full bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold p-4 rounded-xl transition-colors"
          >
            サンプルモードで試す
          </button>
        </div>
      </div>
    </div>
  );
};

const HomeView = ({ battleState, setBattleState, setCurrentView, isSampleMode, setIsSampleMode }: HomeProps) => {
  const handleNewGame = () => {
    if (battleState) {
      const confirmNew = window.confirm("中断された対戦データがあります。\n新しく始めると前のデータは消えますがよろしいですか？");
      if (!confirmNew) return;
      setBattleState(null);
      localStorage.removeItem(STORAGE_KEY_STATE);
    }
    setCurrentView('setup');
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <div className="bg-blue-600 text-white p-6 rounded-b-3xl shadow-md">
        <h1 className="text-3xl font-bold mb-2">クイズ対戦</h1>
        <p className="text-blue-100 opacity-90">親子や兄弟で楽しく学ぼう！</p>
      </div>

      <div className="flex-1 p-6 flex flex-col gap-4">
        {battleState && (
          <button 
            onClick={() => setCurrentView('battle')}
            className="w-full bg-orange-500 hover:bg-orange-600 active:scale-95 transition-transform text-white p-5 rounded-2xl shadow flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <Zap className="w-8 h-8" />
              <div className="text-left">
                <div className="font-bold text-lg">対戦を再開する</div>
                <div className="text-sm opacity-90">中断された対戦があります</div>
              </div>
            </div>
            <ArrowRight className="w-6 h-6" />
          </button>
        )}

        <button 
          onClick={handleNewGame}
          className="w-full bg-blue-500 hover:bg-blue-600 active:scale-95 transition-transform text-white p-6 rounded-2xl shadow flex items-center justify-center gap-3 text-xl font-bold"
        >
          <Play className="w-8 h-8" /> 新しい対戦を始める
        </button>

        <div className="grid grid-cols-2 gap-4">
          <button 
            onClick={() => setCurrentView('history')}
            className="bg-white p-5 rounded-2xl shadow text-slate-700 hover:bg-slate-50 active:scale-95 transition-transform flex flex-col items-center gap-2"
          >
            <History className="w-8 h-8 text-indigo-500" />
            <span className="font-bold">対戦履歴</span>
          </button>
          
          <button 
            onClick={() => setCurrentView('stats')}
            className="bg-white p-5 rounded-2xl shadow text-slate-700 hover:bg-slate-50 active:scale-95 transition-transform flex flex-col items-center gap-2"
          >
            <BarChart2 className="w-8 h-8 text-emerald-500" />
            <span className="font-bold">成績分析</span>
          </button>
        </div>

        <button 
          onClick={() => setCurrentView('settings')}
          className="bg-white p-5 rounded-2xl shadow text-slate-700 hover:bg-slate-50 active:scale-95 transition-transform flex items-center justify-center gap-3"
        >
          <Settings className="w-6 h-6 text-slate-500" />
          <span className="font-bold">設定・プレイヤー</span>
        </button>

        <div className="mt-auto bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-700">サンプルモード切替</span>
            <span className="text-xs text-slate-500">クラウド保存なしで試す</span>
          </div>
          <button 
            onClick={() => {
              setIsSampleMode(!isSampleMode);
            }}
            className={`w-14 h-8 rounded-full relative transition-colors ${isSampleMode ? 'bg-green-500' : 'bg-slate-300'}`}
          >
            <div className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-transform ${isSampleMode ? 'left-7' : 'left-1'}`} />
          </button>
        </div>
      </div>
    </div>
  );
};

const SetupView = ({ players, setBattleState, soundEnabled, setCurrentView, setErrorMsg }: any) => {
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [title, setTitle] = useState('');
  const [timeLimit, setTimeLimit] = useState(30);

  // アクティブなプレイヤーのみを選択可能にする
  const activePlayers = players.filter((p: Player) => p.isActive !== false);

  const [playerAId, setPlayerAId] = useState(activePlayers[0]?.id || '');
  const [playerBId, setPlayerBId] = useState(activePlayers[1]?.id || '');
  const [firstTurn, setFirstTurn] = useState<'A'|'B'>('A');

  const handleStart = () => {
    if (playerAId === playerBId) {
      setErrorMsg('異なるプレイヤーを選択してください');
      return;
    }
    
    const finalTitle = title.trim() === '' ? `${category}クイズ ${date.replace(/-/g, '/')}` : title;
    
    const pA = players.find((p: Player) => p.id === playerAId);
    const pB = players.find((p: Player) => p.id === playerBId);
    
    // ハンデ 小学生の初期スコアを +3
    let scoreA = pA?.handicap === 'primary' ? 3 : (pA?.handicap === 'custom' ? (pA?.customScoreOffset || 0) : 0);
    let scoreB = pB?.handicap === 'primary' ? 3 : (pB?.handicap === 'custom' ? (pB?.customScoreOffset || 0) : 0);

    const newBattleState: BattleState = {
      date,
      title: finalTitle,
      category,
      timeLimitSec: timeLimit,
      players: { playerAId, playerBId },
      scores: { playerA: scoreA, playerB: scoreB },
      rounds: [],
      currentRound: 1,
      questioner: firstTurn === 'A' ? 'A' : 'B',
      startTime: new Date().toISOString()
    };
    
    setBattleState(newBattleState);
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(newBattleState));
    
    if (soundEnabled) {
      unlockAudio().catch(console.error);
    }
    
    setCurrentView('battle');
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 overflow-y-auto relative">
      <div className="bg-white p-4 border-b flex items-center sticky top-0 z-10">
        <button onClick={() => setCurrentView('home')} className="p-2 -ml-2 text-slate-500">
          <ChevronLeft className="w-8 h-8" />
        </button>
        <h2 className="text-xl font-bold mx-auto pr-8">対戦設定</h2>
      </div>

      <div className="p-5 flex flex-col gap-5">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-1">対戦日</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full border border-slate-200 rounded-lg p-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-1">カテゴリ</label>
          <select value={category} onChange={e => setCategory(e.target.value)} className="w-full border border-slate-200 rounded-lg p-3 bg-white appearance-none font-bold text-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-1">タイトル (任意)</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder={`${category}クイズ ${date.replace(/-/g, '/')}`} className="w-full border border-slate-200 rounded-lg p-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-3">プレイヤー設定</label>
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 w-full min-w-[120px]">
              <span className="text-xs font-bold text-blue-500 mb-1 block">プレイヤーA (赤)</span>
              <select value={playerAId} onChange={e => setPlayerAId(e.target.value)} className="w-full border-2 border-red-200 rounded-lg p-3 font-bold bg-red-50 text-red-900 focus:outline-none focus:ring-2 focus:ring-red-500">
                {activePlayers.map((p: Player) => <option key={p.id} value={p.id}>{p.name} {p.handicap === 'primary'?'(小)':p.handicap === 'junior'?'(中)':p.handicap === 'custom'?'(カ)':' '}</option>)}
              </select>
            </div>
            <span className="font-bold text-slate-400 mt-5">VS</span>
            <div className="flex-1 w-full min-w-[120px]">
              <span className="text-xs font-bold text-blue-500 mb-1 block">プレイヤーB (青)</span>
              <select value={playerBId} onChange={e => setPlayerBId(e.target.value)} className="w-full border-2 border-blue-200 rounded-lg p-3 font-bold bg-blue-50 text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {activePlayers.map((p: Player) => <option key={p.id} value={p.id}>{p.name} {p.handicap === 'primary'?'(小)':p.handicap === 'junior'?'(中)':p.handicap === 'custom'?'(カ)':' '}</option>)}
              </select>
            </div>
          </div>
          
          <div className="flex flex-col gap-2 border-t pt-3 mt-2">
            <span className="text-sm font-bold text-slate-700">先攻（最初に出題する人）</span>
            <div className="flex gap-2">
              <button 
                onClick={() => setFirstTurn('A')}
                className={`flex-1 p-3 rounded-lg font-bold border-2 transition-all ${firstTurn === 'A' ? 'bg-red-500 text-white border-red-600' : 'bg-white text-slate-500 border-slate-200'}`}
              >
                プレイヤーA
              </button>
              <button 
                onClick={() => setFirstTurn('B')}
                className={`flex-1 p-3 rounded-lg font-bold border-2 transition-all ${firstTurn === 'B' ? 'bg-blue-500 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200'}`}
              >
                プレイヤーB
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 mb-6">
          <label className="block text-sm font-bold text-slate-700 mb-1">制限時間</label>
          <div className="flex items-center gap-4">
            <input type="range" min="10" max="60" step="5" value={timeLimit} onChange={e => setTimeLimit(Number(e.target.value))} className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer" />
            <span className="font-bold text-xl w-16 text-right">{timeLimit}秒</span>
          </div>
        </div>

        <button onClick={handleStart} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xl p-5 rounded-2xl shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2">
          <Play fill="currentColor" className="w-6 h-6" /> 対戦スタート！
        </button>
      </div>
    </div>
  );
};

const BattleView = ({ players, battleState, setBattleState, soundEnabled, setCurrentView, saveMatch, setFinishedMatch, setErrorMsg }: any) => {
  const [timeLeft, setTimeLeft] = useState<number>(battleState?.timeLimitSec || 30);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{show: boolean, result: 'correct'|'incorrect'|'timeout'|null}>({show: false, result: null});
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
  const [memoInput, setMemoInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const pA = players.find((p: Player) => p.id === battleState?.players.playerAId);
  const pB = players.find((p: Player) => p.id === battleState?.players.playerBId);
  
  const isQuestionerA = battleState?.questioner === 'A';
  const qPlayer = isQuestionerA ? pA : pB;
  const aPlayer = isQuestionerA ? pB : pA;

  const effectiveTimeLimit = useMemo(() => {
    let limit = battleState?.timeLimitSec || 30;
    if (aPlayer?.handicap === 'junior') limit = Math.max(5, limit - 5);
    else if (aPlayer?.handicap === 'custom') limit = Math.max(5, limit + (aPlayer?.customTimeOffset || 0));
    return limit;
  }, [battleState?.timeLimitSec, aPlayer]);

  useEffect(() => {
    if (!isTimerRunning && !confirmDialog.show && !showFinishConfirm) {
       setTimeLeft(effectiveTimeLimit);
    }
  }, [effectiveTimeLimit, battleState?.currentRound, showFinishConfirm]);

  useEffect(() => {
    if (!isTimerRunning || confirmDialog.show || showFinishConfirm) return;

    if (timeLeft <= 0) {
      if (soundEnabled) {
        // 0秒になったら終了ブザーを鳴らす
        playBeep(220, 0.8, 'sawtooth', 0.8);
      }
      setIsTimerRunning(false);
      setConfirmDialog({show: true, result: 'timeout'});
      return;
    }

    const timerId = setInterval(() => {
      setTimeLeft((prev: number) => {
        const next = prev - 1;
        // 秒が変わるごとの「カン」音 (0秒時は上で処理するので除く)
        if (soundEnabled && next > 0) {
          playBeep(900, 0.04, 'square', 0.35);
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(timerId);
  }, [isTimerRunning, timeLeft, confirmDialog.show, showFinishConfirm, soundEnabled]);

  if (!battleState) return null;

  const handleResultSelect = (result: 'correct' | 'incorrect') => {
    setIsTimerRunning(false);
    setConfirmDialog({show: true, result});
  };

  const confirmResult = () => {
    const res = confirmDialog.result;
    if (!res) return;

    const newScores = { ...battleState.scores };
    let pointPlayerKey: 'playerA' | 'playerB';

    if (res === 'correct') {
      pointPlayerKey = isQuestionerA ? 'playerB' : 'playerA';
    } else {
      pointPlayerKey = isQuestionerA ? 'playerA' : 'playerB';
    }

    newScores[pointPlayerKey] += 1;

    const newRound: Round = {
      roundNo: battleState.currentRound,
      questionerId: qPlayer?.id || '',
      answererId: aPlayer?.id || '',
      result: res,
      pointPlayerId: pointPlayerKey === 'playerA' ? (pA?.id || '') : (pB?.id || ''),
      elapsedSec: effectiveTimeLimit - timeLeft
    };

    const newState = {
      ...battleState,
      scores: newScores,
      rounds: [...battleState.rounds, newRound],
      currentRound: battleState.currentRound + 1,
      questioner: isQuestionerA ? 'B' : 'A'
    };

    setBattleState(newState);
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(newState));
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
    
    const newState = {
      ...battleState,
      scores: newScores,
      rounds: newRounds,
      currentRound: battleState.currentRound - 1,
      questioner: lastRound.questionerId === pA?.id ? 'A' : 'B'
    };

    setBattleState(newState);
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(newState));
  };

  const requestFinish = () => {
    if (battleState.currentRound === 1) {
      setErrorMsg("まだ1問も完了していません。対戦を行ってから終了してください。");
      return;
    }
    setIsTimerRunning(false);
    setShowFinishConfirm(true);
  };

  const executeFinish = async () => {
    setIsSaving(true);
    const finalA = battleState.scores.playerA;
    const finalB = battleState.scores.playerB;
    let winnerId = null;
    let resultStr: "playerA_win" | "playerB_win" | "draw" = "draw";

    if (finalA > finalB) {
      winnerId = pA?.id || null;
      resultStr = 'playerA_win';
    } else if (finalB > finalA) {
      winnerId = pB?.id || null;
      resultStr = 'playerB_win';
    }

    const matchData: Match = {
      id: 'match_' + Date.now().toString(),
      date: battleState.date,
      title: battleState.title,
      category: battleState.category,
      players: battleState.players,
      finalScore: battleState.scores,
      winnerId,
      result: resultStr,
      questionCount: battleState.currentRound - 1,
      timeLimitSec: battleState.timeLimitSec,
      rounds: battleState.rounds,
      memo: memoInput.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      handicapSnapshot: {
        playerA: getHandicapDisplay(pA),
        playerB: getHandicapDisplay(pB)
      }
    };

    if (soundEnabled) {
      await unlockAudio();
      playBeep(440, 0.35, "triangle", 0.8);
      setTimeout(() => playBeep(220, 0.8, "triangle", 0.8), 250);
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
            onClick={async () => {
              if (soundEnabled) {
                await unlockAudio();
                playBeep(660, 0.12, "square", 0.7);
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
             onClick={() => handleResultSelect('incorrect')}
             className={`flex-1 py-6 rounded-2xl font-black text-2xl flex flex-col items-center gap-2 transition-all ${isTimerRunning ? 'bg-red-500 text-white shadow-[0_6px_0_#991b1b] active:translate-y-2 active:shadow-none' : 'bg-slate-200 text-slate-400'}`}
           >
             <X className="w-10 h-10 stroke-[3]" />
             不正解
           </button>
           <button 
             disabled={!isTimerRunning}
             onClick={() => handleResultSelect('correct')}
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
                setConfirmDialog({show: false, result: null});
                if(confirmDialog.result !== 'timeout') setIsTimerRunning(true);
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

const ResultView = ({ finishedMatch, matches, players, setCurrentView }: any) => {
  const latestMatch = finishedMatch || matches[0];
  if (!latestMatch) return <div className="p-5">読込中...</div>;

  const pA = players.find((p: Player) => p.id === latestMatch.players.playerAId);
  const pB = players.find((p: Player) => p.id === latestMatch.players.playerBId);

  return (
    <div className="flex flex-col h-full bg-slate-50 overflow-y-auto">
      <div className={`text-white p-8 pb-12 rounded-b-[3rem] shadow-lg text-center relative overflow-hidden shrink-0 ${latestMatch.result === 'draw' ? 'bg-gradient-to-br from-slate-500 to-slate-400' : 'bg-gradient-to-br from-indigo-600 to-blue-500'}`}>
         {latestMatch.result !== 'draw' ? (
           <Trophy className="w-24 h-24 mx-auto mb-4 text-yellow-300 opacity-90 drop-shadow-md animate-bounce" />
         ) : (
           <Award className="w-24 h-24 mx-auto mb-4 text-slate-200 opacity-90 drop-shadow-md" />
         )}
         <h2 className="text-4xl font-black mb-2">
           {latestMatch.result === 'draw' ? '引き分け！' : `${latestMatch.result === 'playerA_win' ? pA?.name : pB?.name} の勝ち！`}
         </h2>
         <p className="opacity-90">{latestMatch.title}</p>
      </div>

      <div className="px-6 -mt-8 relative z-10 pb-10">
         <div className="bg-white rounded-3xl shadow-xl p-6 border border-slate-100">
            <div className="flex justify-between items-center mb-6">
               <div className="text-center flex-1">
                  <span className="block text-sm font-bold text-red-500 mb-1">{pA?.name}</span>
                  <span className="text-xs text-slate-400 block -mt-1 mb-1 truncate">{latestMatch.handicapSnapshot?.playerA || getHandicapDisplay(pA)}</span>
                  <span className="text-5xl font-black text-slate-800">{latestMatch.finalScore.playerA}</span>
               </div>
               <div className="px-4 text-slate-300 font-black text-3xl mb-4">-</div>
               <div className="text-center flex-1">
                  <span className="block text-sm font-bold text-blue-500 mb-1">{pB?.name}</span>
                  <span className="text-xs text-slate-400 block -mt-1 mb-1 truncate">{latestMatch.handicapSnapshot?.playerB || getHandicapDisplay(pB)}</span>
                  <span className="text-5xl font-black text-slate-800">{latestMatch.finalScore.playerB}</span>
               </div>
            </div>

            <div className="text-center py-4 border-t border-slate-100 bg-slate-50 rounded-xl mb-6">
               <span className="text-sm font-bold text-slate-500 block mb-1">勝者</span>
               <span className="text-2xl font-black text-indigo-600">
                 {latestMatch.result === 'draw' ? '引き分け' : 
                  latestMatch.result === 'playerA_win' ? pA?.name : pB?.name}
               </span>
            </div>

            {latestMatch.memo && (
              <div className="mb-2 p-4 bg-yellow-50 rounded-xl border border-yellow-100">
                <span className="text-xs font-bold text-yellow-600 block mb-1">📝 メモ</span>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{latestMatch.memo}</p>
              </div>
            )}

            <div className="flex flex-col gap-3 mt-6">
              <button 
                onClick={() => setCurrentView('setup')}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-lg p-4 rounded-xl shadow-md active:scale-95 transition-transform flex items-center justify-center gap-2"
              >
                <Play fill="currentColor" className="w-5 h-5" /> もう一度対戦する
              </button>
              <button 
                onClick={() => setCurrentView('history')}
                className="w-full bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-lg p-4 rounded-xl shadow-md active:scale-95 transition-transform flex items-center justify-center gap-2"
              >
                <History className="w-5 h-5" /> 履歴を見る
              </button>
              <button 
                onClick={() => setCurrentView('home')}
                className="w-full bg-white hover:bg-slate-50 text-slate-500 font-bold text-lg p-4 rounded-xl shadow-sm border border-slate-200 active:scale-95 transition-transform"
              >
                ホームへ戻る
              </button>
            </div>
         </div>
      </div>
    </div>
  );
};

const HistoryView = ({ matches, players, setCurrentView, fetchData, setSelectedMatch, deleteMatch }: any) => {
  const [filterCategory, setFilterCategory] = useState('すべて');

  const filteredMatches = useMemo(() => {
    if (filterCategory === 'すべて') return matches;
    return matches.filter((m: Match) => m.category === filterCategory);
  }, [matches, filterCategory]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('この対戦履歴を削除しますか？\nこの操作は取り消せません。')) {
      await deleteMatch(id);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <div className="bg-white p-4 border-b flex items-center sticky top-0 z-10 shadow-sm gap-2">
        <button onClick={() => setCurrentView('home')} className="p-2 -ml-2 text-slate-500">
          <ChevronLeft className="w-8 h-8" />
        </button>
        <h2 className="text-xl font-bold flex-1">対戦履歴</h2>
        <button onClick={fetchData} className="p-2 text-blue-500">
          <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      <div className="px-4 pt-4 pb-2">
        <select 
          value={filterCategory} 
          onChange={(e) => setFilterCategory(e.target.value)}
          className="w-full bg-white border border-slate-200 rounded-lg p-3 font-bold text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="すべて">すべてのカテゴリ</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="p-4 flex flex-col gap-4 overflow-y-auto pb-10 flex-1">
        {filteredMatches.length === 0 ? (
          <div className="text-center text-slate-400 mt-10 font-bold">履歴がありません</div>
        ) : (
          filteredMatches.map((m: Match) => {
            const pA = players.find((p: Player) => p.id === m.players.playerAId);
            const pB = players.find((p: Player) => p.id === m.players.playerBId);
            
            return (
              <button 
                key={m.id} 
                onClick={() => { setSelectedMatch(m); setCurrentView('history_detail'); }}
                className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 flex flex-col text-left active:scale-95 transition-transform relative group"
              >
                <div className="flex justify-between items-start mb-3 border-b border-slate-50 pb-3">
                  <div className="pr-10">
                    <span className="text-xs font-bold text-indigo-500 bg-indigo-50 px-2 py-1 rounded-md">{m.category}</span>
                    <span className="text-xs text-slate-400 ml-2">{m.date.replace(/-/g, '/')}</span>
                    <h3 className="font-bold text-slate-800 mt-2 text-lg">{m.title}</h3>
                  </div>
                  <div className="absolute top-4 right-4 flex items-center gap-2">
                    {m.result !== 'draw' && <Award className="w-7 h-7 text-yellow-400 drop-shadow-sm shrink-0" />}
                    <div 
                      onClick={(e) => handleDelete(e, m.id)} 
                      className="p-2 hover:bg-red-50 rounded-full transition-colors z-10"
                    >
                      <Trash2 className="w-5 h-5 text-slate-300 hover:text-red-500" />
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center justify-between gap-3 mt-1 mt-4">
                   <div className={`relative flex-1 flex flex-col items-center py-2 rounded-xl border-2 transition-colors ${m.result === 'playerA_win' ? 'bg-red-50 border-red-400 shadow-sm' : 'border-transparent'}`}>
                      {m.result === 'playerA_win' && <span className="text-base absolute -top-4">👑</span>}
                      <span className="text-xs font-bold text-slate-500 truncate w-full text-center px-1">{pA?.name || '不明'}</span>
                      <span className={`text-2xl font-black ${m.result === 'playerA_win' ? 'text-red-600' : 'text-slate-700'}`}>{m.finalScore.playerA}</span>
                   </div>
                   <span className="text-slate-300 font-black text-xl">-</span>
                   <div className={`relative flex-1 flex flex-col items-center py-2 rounded-xl border-2 transition-colors ${m.result === 'playerB_win' ? 'bg-blue-50 border-blue-400 shadow-sm' : 'border-transparent'}`}>
                      {m.result === 'playerB_win' && <span className="text-base absolute -top-4">👑</span>}
                      <span className="text-xs font-bold text-slate-500 truncate w-full text-center px-1">{pB?.name || '不明'}</span>
                      <span className={`text-2xl font-black ${m.result === 'playerB_win' ? 'text-blue-600' : 'text-slate-700'}`}>{m.finalScore.playerB}</span>
                   </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

const HistoryDetailView = ({
  match,
  players,
  setCurrentView,
  updateMatch,
  deleteMatch,
}: {
  match: Match | null;
  players: Player[];
  setCurrentView: (view: any) => void;
  updateMatch: (match: Match) => Promise<boolean>;
  deleteMatch: (matchId: string) => Promise<boolean>;
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [editDate, setEditDate] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editMemo, setEditMemo] = useState('');

  useEffect(() => {
    if (match && !isEditing) {
      setEditDate(match.date);
      setEditTitle(match.title);
      setEditCategory(match.category);
      setEditMemo(match.memo || '');
    }
  }, [match, isEditing]);

  if (!match) return <div className="p-5 flex flex-col h-full bg-slate-50">見つかりません</div>;

  const pA = players.find((p: Player) => p.id === match.players.playerAId);
  const pB = players.find((p: Player) => p.id === match.players.playerBId);

  const hasChanges = match && (editDate !== match.date || editTitle !== match.title || editCategory !== match.category || editMemo !== (match.memo || ''));

  const getPlayerName = (id: string) => {
    if (id === pA?.id) return pA?.name;
    if (id === pB?.id) return pB?.name;
    return '不明';
  };

  const handleBack = () => {
    if (isEditing && hasChanges) {
      if (!window.confirm('未保存の変更があります。\n破棄して戻りますか？')) return;
    }
    setCurrentView('history');
  };

  const handleCancelEdit = () => {
    if (hasChanges) {
      if (!window.confirm('未保存の変更があります。\n破棄してもよろしいですか？')) return;
    }
    setIsEditing(false);
    setEditDate(match.date);
    setEditTitle(match.title);
    setEditCategory(match.category);
    setEditMemo(match.memo || '');
  };

  const handleSaveEdit = async () => {
    setIsSaving(true);
    const updatedMatch: Match = {
      ...match,
      date: editDate,
      title: editTitle,
      category: editCategory,
      memo: editMemo.trim()
    };
    const success = await updateMatch(updatedMatch);
    setIsSaving(false);
    if (success) {
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    if (window.confirm('この対戦履歴を削除しますか？\nこの操作は取り消せません。')) {
      setIsSaving(true);
      const success = await deleteMatch(match.id);
      setIsSaving(false);
      if (success) {
        setCurrentView('history');
      }
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <div className="bg-white p-4 border-b flex items-center sticky top-0 z-10 shadow-sm relative">
        {isSaving && (
          <div className="absolute inset-0 bg-white/80 z-20 flex items-center justify-center backdrop-blur-sm">
            <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
            <span className="ml-2 font-bold text-slate-600 text-sm">処理中...</span>
          </div>
        )}
        <button onClick={handleBack} className="p-2 -ml-2 text-slate-500" disabled={isSaving}>
          <ChevronLeft className="w-8 h-8" />
        </button>
        <h2 className="text-xl font-bold mx-auto pr-8">対戦詳細</h2>
      </div>

      <div className="p-4 flex flex-col gap-4 overflow-y-auto pb-10">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 relative">
          
          {isEditing ? (
            <div className="flex flex-col gap-4 mb-4 border-b border-slate-100 pb-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">対戦日</label>
                <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} className="w-full border border-slate-200 rounded-lg p-2 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">カテゴリ</label>
                <select value={editCategory} onChange={e => setEditCategory(e.target.value)} className="w-full border border-slate-200 rounded-lg p-2 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">タイトル</label>
                <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} className="w-full border border-slate-200 rounded-lg p-2 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">メモ</label>
                <textarea value={editMemo} onChange={e => setEditMemo(e.target.value)} className="w-full border border-slate-200 rounded-lg p-2 text-sm h-20 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="flex gap-3 mt-2">
                <button onClick={handleCancelEdit} disabled={isSaving} className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-xl font-bold transition-colors">キャンセル</button>
                <button onClick={handleSaveEdit} disabled={isSaving} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 shadow-md transition-colors">
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin"/> : '保存する'}
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-4">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold text-indigo-500 bg-indigo-50 px-2 py-1 rounded-md">{match.category}</span>
                  <span className="text-xs text-slate-400 ml-2">{match.date.replace(/-/g, '/')}</span>
                </div>
              </div>
              <h3 className="font-bold text-slate-800 mt-3 text-xl">{match.title}</h3>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 mb-4 border-t border-slate-100 pt-4">
             <div className="flex-1 text-center">
                <span className="text-xs font-bold text-red-500 block">{pA?.name}</span>
                <span className="text-xs text-slate-400 block truncate">{match.handicapSnapshot?.playerA || getHandicapDisplay(pA)}</span>
                <span className="text-3xl font-black">{match.finalScore.playerA}</span>
             </div>
             <span className="text-slate-300 font-black text-xl">-</span>
             <div className="flex-1 text-center">
                <span className="text-xs font-bold text-blue-500 block">{pB?.name}</span>
                <span className="text-xs text-slate-400 block truncate">{match.handicapSnapshot?.playerB || getHandicapDisplay(pB)}</span>
                <span className="text-3xl font-black">{match.finalScore.playerB}</span>
             </div>
          </div>
          
          {!isEditing && match.memo && (
            <div className="p-4 bg-yellow-50 rounded-xl border border-yellow-100 mt-2">
              <span className="text-xs font-bold text-yellow-600 block mb-1">📝 メモ</span>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{match.memo}</p>
            </div>
          )}

          {!isEditing && (
            <div className="flex gap-3 mt-6 pt-4 border-t border-slate-100">
              <button onClick={() => setIsEditing(true)} disabled={isSaving} className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors">
                <Edit2 className="w-4 h-4" /> 編集
              </button>
              <button onClick={handleDelete} disabled={isSaving} className="flex-1 bg-red-50 hover:bg-red-100 text-red-600 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors">
                <Trash2 className="w-4 h-4" /> 削除
              </button>
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mt-2">
          <h4 className="font-bold text-slate-700 p-4 border-b bg-slate-50">ラウンド詳細</h4>
          {match.rounds.length > 0 ? (
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3">No</th>
                  <th className="px-4 py-3">出題・回答</th>
                  <th className="px-4 py-3 text-center">結果</th>
                  <th className="px-4 py-3 text-right">得点</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {match.rounds.map((r: Round) => (
                  <tr key={r.roundNo} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4 font-bold text-slate-500">{r.roundNo}</td>
                    <td className="px-4 py-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1 text-[10px] text-slate-400">
                          <Volume2 className="w-3 h-3"/> <span>{getPlayerName(r.questionerId)}</span>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] font-bold text-slate-700">
                          <span className="opacity-50">↳</span> <span>{getPlayerName(r.answererId)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center">
                      {r.result === 'correct' && <Check className="w-5 h-5 text-emerald-500 mx-auto"/>}
                      {r.result === 'incorrect' && <X className="w-5 h-5 text-red-500 mx-auto"/>}
                      {r.result === 'timeout' && <Clock className="w-4 h-4 text-amber-500 mx-auto"/>}
                    </td>
                    <td className="px-4 py-4 font-bold text-indigo-600 text-right truncate max-w-[80px]">
                      {getPlayerName(r.pointPlayerId)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-6 text-center text-slate-400 text-sm font-bold">ラウンドデータがありません</div>
          )}
        </div>
      </div>
    </div>
  );
};


const StatsView = ({ matches, players, setCurrentView }: any) => {
  const statsData = players.map((p: Player) => {
    const pMatches = matches.filter((m: Match) => m.players.playerAId === p.id || m.players.playerBId === p.id);
    const totalGames = pMatches.length;
    let wins = 0;
    let totalPoints = 0;

    pMatches.forEach((m: Match) => {
      if (m.winnerId === p.id) wins++;
      totalPoints += m.players.playerAId === p.id ? m.finalScore.playerA : m.finalScore.playerB;
    });

    return {
      name: p.name,
      totalGames,
      wins,
      winRate: totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0,
      totalPoints,
    };
  }).filter((d: any) => d.totalGames > 0);

  // 勝利数ランキングでソート
  statsData.sort((a: any, b: any) => b.wins - a.wins);

  const categoryPlayerStats: Record<string, { games: number, players: Record<string, { wins: number, games: number, score: number }> }> = {};
  
  matches.forEach((m: Match) => {
    if (!categoryPlayerStats[m.category]) {
      categoryPlayerStats[m.category] = { games: 0, players: {} };
    }
    categoryPlayerStats[m.category].games++;

    [m.players.playerAId, m.players.playerBId].forEach((pId, idx) => {
      if (!categoryPlayerStats[m.category].players[pId]) {
        categoryPlayerStats[m.category].players[pId] = { wins: 0, games: 0, score: 0 };
      }
      categoryPlayerStats[m.category].players[pId].games++;
      categoryPlayerStats[m.category].players[pId].score += idx === 0 ? m.finalScore.playerA : m.finalScore.playerB;
      if (m.winnerId === pId) {
        categoryPlayerStats[m.category].players[pId].wins++;
      }
    });
  });

  const pieData = Object.keys(categoryPlayerStats).map(k => ({ name: k, value: categoryPlayerStats[k].games }));

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <div className="bg-white p-4 border-b flex items-center sticky top-0 z-10 shadow-sm">
        <button onClick={() => setCurrentView('home')} className="p-2 -ml-2 text-slate-500">
          <ChevronLeft className="w-8 h-8" />
        </button>
        <h2 className="text-xl font-bold mx-auto pr-8">成績分析</h2>
      </div>

      <div className="p-4 flex flex-col gap-6 overflow-y-auto pb-10">
        {statsData.length === 0 ? (
           <div className="text-center text-slate-400 mt-10 font-bold">データがありません</div>
        ) : (
          <>
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
              <h3 className="font-bold text-slate-700 mb-4">ランキング・勝率比較</h3>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statsData} margin={{ top: 10, right: 10, left: -20, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fontWeight: 'bold' }} angle={-45} textAnchor="end" />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                    <RechartsTooltip cursor={{fill: '#f1f5f9'}} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Bar dataKey="winRate" fill="#3b82f6" radius={[6, 6, 0, 0]} name="勝率(%)" barSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
              <h3 className="font-bold text-slate-700 mb-4">プレイしたカテゴリ</h3>
              <div className="h-72 w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="45%" innerRadius={50} outerRadius={70} paddingAngle={5} dataKey="value">
                      {pieData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend verticalAlign="bottom" height={36} wrapperStyle={{ fontSize: '12px', fontWeight: 'bold' }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none flex-col" style={{ marginTop: '-36px' }}>
                   <span className="text-3xl font-black text-slate-700">{matches.length}</span>
                   <span className="text-xs font-bold text-slate-400">Games</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="font-bold text-slate-700 ml-1">カテゴリ別成績</h3>
              {Object.keys(categoryPlayerStats).map(cat => {
                const stat = categoryPlayerStats[cat];
                return (
                  <div key={cat} className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex flex-col gap-2">
                    <div className="flex justify-between items-end border-b border-slate-50 pb-2">
                      <span className="font-bold text-indigo-600 text-lg">{cat}</span>
                      <span className="text-xs font-bold text-slate-400">対戦数: {stat.games}</span>
                    </div>
                    <div className="flex flex-col gap-2 mt-1">
                      {Object.entries(stat.players).map(([pId, pStat]) => {
                        const player = players.find((p: Player) => p.id === pId);
                        if (!player) return null;
                        const winRate = pStat.games > 0 ? Math.round((pStat.wins / pStat.games) * 100) : 0;
                        const avgScore = pStat.games > 0 ? (pStat.score / pStat.games).toFixed(1) : "0.0";
                        return (
                          <div key={pId} className="flex justify-between items-center text-sm bg-slate-50 p-2 rounded-lg">
                            <span className="font-bold text-slate-700 w-20 truncate">{player.name}</span>
                            <div className="flex flex-1 justify-around text-center">
                              <div>
                                <span className="text-[10px] text-slate-400 block mb-0.5">勝率</span>
                                <span className="font-black text-slate-700">{winRate}%</span>
                              </div>
                              <div>
                                <span className="text-[10px] text-slate-400 block mb-0.5">平均得点</span>
                                <span className="font-black text-slate-700">{avgScore}</span>
                              </div>
                              <div>
                                <span className="text-[10px] text-slate-400 block mb-0.5">対戦数</span>
                                <span className="font-black text-slate-700">{pStat.games}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const SettingsView = ({ players, savePlayers, setCurrentView, isSampleMode, setIsSampleMode, soundEnabled, setSoundEnabled, setErrorMsg }: any) => {
  const [editingPlayers, setEditingPlayers] = useState<Player[]>(JSON.parse(JSON.stringify(players)));
  const [isSaving, setIsSaving] = useState(false);

  const activeEditingPlayers = editingPlayers.filter(p => p.isActive !== false);

  const updatePlayer = (id: string, field: keyof Player, value: string | number) => {
    setEditingPlayers(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  const addPlayer = () => {
    const newP: Player = { id: 'p_' + Date.now(), name: 'なまえ', handicap: 'none', isActive: true };
    setEditingPlayers([...editingPlayers, newP]);
  };

  const removePlayer = (id: string) => {
    if (activeEditingPlayers.length <= 2) {
      setErrorMsg("プレイヤーは最低2人必要です");
      return;
    }
    setEditingPlayers(prev => prev.map(p => p.id === id ? { ...p, isActive: false } : p));
  };

  const handleSave = async () => {
    if (activeEditingPlayers.some(p => p.name.trim() === '')) {
      setErrorMsg('名前が空のプレイヤーがいます。');
      return;
    }
    setIsSaving(true);
    await savePlayers(editingPlayers);
    setIsSaving(false);
    setCurrentView('home');
  };

  const handleLogout = async () => {
    if (window.confirm('ログアウトしますか？')) {
      const auth = getAuth();
      await auth.signOut();
      if (isSampleMode) setIsSampleMode(false);
      setCurrentView('home');
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 relative">
      <div className="bg-white p-4 border-b flex items-center sticky top-0 z-10 shadow-sm">
        <button onClick={() => setCurrentView('home')} className="p-2 -ml-2 text-slate-500" disabled={isSaving}>
          <X className="w-6 h-6" />
        </button>
        <h2 className="text-xl font-bold mx-auto pr-8">設定</h2>
      </div>

      <div className="p-5 flex flex-col gap-6 overflow-y-auto pb-32">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
          <div className="flex justify-between items-center mb-4">
             <h3 className="font-bold text-slate-700 flex items-center gap-2"><User className="w-5 h-5"/> プレイヤー管理</h3>
             <button onClick={addPlayer} className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-full flex items-center gap-1">
               <Plus className="w-4 h-4"/> 追加
             </button>
          </div>
          
          <div className="flex flex-col gap-4">
            {activeEditingPlayers.map(p => (
              <div key={p.id} className="border border-slate-100 rounded-xl p-3 bg-slate-50 relative flex gap-3 items-start flex-wrap sm:flex-nowrap">
                 <div className="flex-1 w-full">
                    <input 
                      type="text" 
                      value={p.name} 
                      onChange={e => updatePlayer(p.id, 'name', e.target.value)} 
                      className="w-full font-bold text-lg p-3 rounded-lg border border-slate-200 mb-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <select 
                      value={p.handicap} 
                      onChange={e => updatePlayer(p.id, 'handicap', e.target.value)}
                      className="w-full p-3 text-sm rounded-lg border border-slate-200 bg-white font-bold text-slate-600 mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                       <option value="none">ハンデなし</option>
                       <option value="primary">小学生 (初期スコア+3)</option>
                       <option value="junior">中学生 (回答時間-5秒)</option>
                       <option value="custom">カスタム設定</option>
                    </select>
                    {p.handicap === 'custom' && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 w-full">
                        <div>
                          <label className="block text-xs font-bold text-slate-500 mb-1">初期スコア(+)</label>
                          <input type="number" min="0" value={p.customScoreOffset ?? 0} onChange={e => updatePlayer(p.id, 'customScoreOffset', Number(e.target.value))} className="w-full border border-slate-200 rounded-lg p-3 text-base font-bold bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-slate-500 mb-1">回答時間増減(秒)</label>
                          <input type="number" value={p.customTimeOffset ?? 0} onChange={e => updatePlayer(p.id, 'customTimeOffset', Number(e.target.value))} className="w-full border border-slate-200 rounded-lg p-3 text-base font-bold bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="例: 10 または -5" />
                        </div>
                      </div>
                    )}
                 </div>
                 <button onClick={() => removePlayer(p.id)} className="p-3 text-red-400 hover:bg-red-50 rounded-lg transition-colors ml-auto self-start mt-1">
                   <Trash2 className="w-6 h-6" />
                 </button>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
           <h3 className="font-bold text-slate-700 mb-4">システム設定</h3>
           <div className="flex items-center justify-between py-2 border-b border-slate-50">
              <div className="flex items-center gap-3">
                {soundEnabled ? <Volume2 className="w-5 h-5 text-slate-500"/> : <VolumeX className="w-5 h-5 text-slate-400"/>}
                <span className="font-bold text-slate-700">効果音</span>
              </div>
              <button 
                onClick={() => setSoundEnabled(!soundEnabled)}
                className={`w-14 h-8 rounded-full relative transition-colors ${soundEnabled ? 'bg-blue-500' : 'bg-slate-300'}`}
              >
                <div className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-transform ${soundEnabled ? 'left-7' : 'left-1'}`} />
              </button>
           </div>
           
           {isSampleMode && (
              <div className="mt-4 p-3 bg-amber-50 text-amber-800 text-sm font-bold rounded-lg flex gap-2">
                 <AlertCircle className="w-5 h-5 shrink-0" />
                 現在サンプルモードです。データはブラウザにのみ保存されます。
              </div>
           )}

           <button 
             onClick={handleLogout}
             className="w-full flex items-center justify-center gap-2 mt-6 p-4 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-xl transition-colors"
           >
             <LogOut className="w-5 h-5" />
             ログアウトする
           </button>
        </div>
      </div>
      
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-white border-t shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.05)]">
        <button 
          onClick={handleSave} 
          disabled={isSaving}
          className="w-full bg-slate-800 hover:bg-slate-900 disabled:bg-slate-400 text-white font-bold text-xl p-4 rounded-xl shadow-md active:scale-95 transition-all flex items-center justify-center gap-2"
        >
          {isSaving ? <Loader2 className="w-6 h-6 animate-spin" /> : '設定を保存する'}
        </button>
      </div>
    </div>
  );
};


// --- Main App Component ---
export default function App() {
  const [user, setUser] = useState<FirebaseAuthUser | null>(null);
  const [isSampleMode, setIsSampleMode] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  
  const [currentView, setCurrentView] = useState<'home' | 'setup' | 'battle' | 'result' | 'history' | 'history_detail' | 'stats' | 'settings'>('home');
  
  const [players, setPlayers] = useState<Player[]>(DEFAULT_PLAYERS);
  const [matches, setMatches] = useState<Match[]>([]);
  
  const [battleState, setBattleState] = useState<BattleState | null>(null);
  const [finishedMatch, setFinishedMatch] = useState<Match | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const [appError, setAppError] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  const generateMockData = () => {
    const mockPlayers: Player[] = [
      { id: 'p1', name: '太郎 (父)', handicap: 'none', isActive: true },
      { id: 'p2', name: '花子 (小5)', handicap: 'primary', isActive: true },
      { id: 'p3', name: '一郎 (中2)', handicap: 'junior', isActive: true }
    ];
    const mockMatches: Match[] = [];
    const now = new Date().getTime();
    
    for (let i = 0; i < 20; i++) {
      const d = new Date(now - Math.random() * 86400000 * 30).toISOString();
      const cat = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
      const pA = mockPlayers[Math.floor(Math.random() * 3)];
      const pB = mockPlayers.find(p => p.id !== pA.id) || mockPlayers[0];
      const scoreA = Math.floor(Math.random() * 5) + 2;
      const scoreB = Math.floor(Math.random() * 5) + 2;
      
      let winnerId = null;
      let result: "playerA_win" | "playerB_win" | "draw" = "draw";
      if (scoreA > scoreB) { winnerId = pA.id; result = 'playerA_win'; }
      else if (scoreB > scoreA) { winnerId = pB.id; result = 'playerB_win'; }

      mockMatches.push({
        id: `mock_${i}`,
        date: d.split('T')[0],
        title: `${cat}クイズ ${d.split('T')[0].replace(/-/g, '/')}`,
        category: cat,
        players: { playerAId: pA.id, playerBId: pB.id },
        finalScore: { playerA: scoreA, playerB: scoreB },
        winnerId,
        result,
        questionCount: scoreA + scoreB - (pA.handicap==='primary'?3:0) - (pB.handicap==='primary'?3:0),
        timeLimitSec: 30,
        rounds: [], 
        memo: Math.random() > 0.7 ? 'とても良い勝負だった。' : '',
        createdAt: d,
        updatedAt: d,
        handicapSnapshot: {
          playerA: getHandicapDisplay(pA),
          playerB: getHandicapDisplay(pB)
        }
      });
    }
    mockMatches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { mockPlayers, mockMatches };
  };

  const fetchData = useCallback(async () => {
    if (isSampleMode) {
      const localPlayers = localStorage.getItem('quiz_players_sample');
      const localMatches = localStorage.getItem('quiz_matches_sample');
      
      if (localPlayers && localMatches) {
        setPlayers(JSON.parse(localPlayers));
        setMatches(JSON.parse(localMatches));
      } else {
        const { mockPlayers, mockMatches } = generateMockData();
        setPlayers(mockPlayers);
        setMatches(mockMatches);
        localStorage.setItem('quiz_players_sample', JSON.stringify(mockPlayers));
        localStorage.setItem('quiz_matches_sample', JSON.stringify(mockMatches));
      }
      return;
    }

    if (!user) return;

    try {
      const playerSnap = await getDocs(getPlayersRef());
      const fetchedPlayers: Player[] = [];
      playerSnap.forEach(doc => fetchedPlayers.push(doc.data() as Player));
      if (fetchedPlayers.length > 0) setPlayers(fetchedPlayers);

      const matchSnap = await getDocs(getMatchesRef());
      const fetchedMatches: Match[] = [];
      matchSnap.forEach(doc => fetchedMatches.push(doc.data() as Match));
      fetchedMatches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setMatches(fetchedMatches);
    } catch (error) {
      console.error("Fetch Data Error:", error);
    }
  }, [user, isSampleMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const savedState = localStorage.getItem(STORAGE_KEY_STATE);
    if (savedState) {
      try {
        setBattleState(JSON.parse(savedState));
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY_STATE);
      }
    }
  }, []);

  const saveMatch = async (matchData: Match): Promise<boolean> => {
    if (isSampleMode) {
      setMatches(prev => {
        const newMatches = [matchData, ...prev];
        localStorage.setItem('quiz_matches_sample', JSON.stringify(newMatches));
        return newMatches;
      });
      localStorage.removeItem(STORAGE_KEY_STATE);
      setBattleState(null);
      return true;
    } 
    
    if (!user) return false;

    try {
      const docRef = doc(getMatchesRef(), matchData.id);
      await setDoc(docRef, matchData);
      setMatches(prev => [matchData, ...prev]);
      localStorage.removeItem(STORAGE_KEY_STATE);
      setBattleState(null);
      return true;
    } catch (e) {
      console.error("Save Match Error:", e);
      setAppError("データの保存に失敗しました。通信環境を確認してください。");
      return false;
    }
  };

  const updateMatch = async (matchData: Match): Promise<boolean> => {
    matchData.updatedAt = new Date().toISOString();
    
    if (isSampleMode) {
      setMatches(prev => {
        const newMatches = prev.map(m => m.id === matchData.id ? matchData : m);
        localStorage.setItem('quiz_matches_sample', JSON.stringify(newMatches));
        return newMatches;
      });
      return true;
    }
    
    if (!user) return false;

    try {
      const docRef = doc(getMatchesRef(), matchData.id);
      await setDoc(docRef, matchData);
      setMatches(prev => prev.map(m => m.id === matchData.id ? matchData : m));
      return true;
    } catch (e) {
      console.error("Update Match Error:", e);
      setAppError("対戦履歴の更新に失敗しました。");
      return false;
    }
  };

  const deleteMatch = async (matchId: string): Promise<boolean> => {
    if (isSampleMode) {
      setMatches(prev => {
        const newMatches = prev.filter(m => m.id !== matchId);
        localStorage.setItem('quiz_matches_sample', JSON.stringify(newMatches));
        return newMatches;
      });
      return true;
    }

    if (!user) return false;

    try {
      const docRef = doc(getMatchesRef(), matchId);
      await deleteDoc(docRef);
      setMatches(prev => prev.filter(m => m.id !== matchId));
      return true;
    } catch (e) {
      console.error("Delete Match Error:", e);
      setAppError("対戦履歴の削除に失敗しました。");
      return false;
    }
  };

  const savePlayers = async (newPlayers: Player[]) => {
    if (isSampleMode) {
      setPlayers(newPlayers);
      localStorage.setItem('quiz_players_sample', JSON.stringify(newPlayers));
      return;
    } 
    
    if (user) {
      try {
        for (const p of newPlayers) {
          const docRef = doc(getPlayersRef(), p.id);
          await setDoc(docRef, p);
        }
        setPlayers(newPlayers);
      } catch (e) {
        console.error("Save Players Error:", e);
        setAppError("プレイヤーの保存に失敗しました。");
      }
    }
  };

  if (!user && !isSampleMode) {
    return (
      <div className="w-full max-w-md mx-auto h-screen bg-slate-100 overflow-hidden shadow-2xl relative select-none font-sans text-slate-800">
        <ErrorToast msg={appError} onClose={() => setAppError('')} />
        <LoginView setIsSampleMode={setIsSampleMode} setErrorMsg={setAppError} />
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto h-screen bg-slate-100 overflow-hidden shadow-2xl relative select-none font-sans text-slate-800 flex flex-col">
      {isSampleMode && (
        <div className="bg-amber-500 text-white text-[11px] font-bold py-1 px-4 text-center z-50 flex items-center justify-center gap-1 shrink-0">
          <AlertCircle className="w-3 h-3" /> サンプルモード中（保存されません）
        </div>
      )}
      
      <div className="flex-1 relative overflow-hidden">
        <ErrorToast msg={appError} onClose={() => setAppError('')} />
        
        {currentView === 'home' && (
          <HomeView 
            battleState={battleState} 
            setBattleState={setBattleState}
            setCurrentView={setCurrentView} 
            isSampleMode={isSampleMode} 
            setIsSampleMode={setIsSampleMode} 
            setErrorMsg={setAppError}
          />
        )}
        {currentView === 'setup' && (
          <SetupView 
            players={players} 
            setBattleState={setBattleState} 
            soundEnabled={soundEnabled} 
            setCurrentView={setCurrentView}
            setErrorMsg={setAppError} 
          />
        )}
        {currentView === 'battle' && (
          <BattleView 
            players={players} 
            battleState={battleState} 
            setBattleState={setBattleState} 
            soundEnabled={soundEnabled} 
            setCurrentView={setCurrentView} 
            saveMatch={saveMatch} 
            setFinishedMatch={setFinishedMatch}
            setErrorMsg={setAppError} 
          />
        )}
        {currentView === 'result' && (
          <ResultView 
            finishedMatch={finishedMatch}
            matches={matches} 
            players={players} 
            setCurrentView={setCurrentView} 
          />
        )}
        {currentView === 'history' && (
          <HistoryView 
            matches={matches} 
            players={players} 
            setCurrentView={setCurrentView} 
            fetchData={fetchData}
            setSelectedMatch={setSelectedMatch} 
            deleteMatch={deleteMatch}
          />
        )}
        {currentView === 'history_detail' && (
          <HistoryDetailView 
            match={selectedMatch}
            players={players} 
            setCurrentView={setCurrentView} 
            updateMatch={updateMatch}
            deleteMatch={deleteMatch}
          />
        )}
        {currentView === 'stats' && (
          <StatsView 
            matches={matches} 
            players={players} 
            setCurrentView={setCurrentView} 
          />
        )}
        {currentView === 'settings' && (
          <SettingsView 
            players={players} 
            savePlayers={savePlayers} 
            setCurrentView={setCurrentView} 
            isSampleMode={isSampleMode} 
            setIsSampleMode={setIsSampleMode}
            soundEnabled={soundEnabled} 
            setSoundEnabled={setSoundEnabled}
            setErrorMsg={setAppError} 
          />
        )}
      </div>
    </div>
  );
}