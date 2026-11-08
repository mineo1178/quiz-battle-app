import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { cancelSounds, ensureAudioReady, getAudioState, playStartSound, setAudioEnabled } from './sound';
import { createBattleState, getHandicapDisplay, parseSavedBattleState } from './battleLogic';
import type { BattleState, Match, Player, Round } from './battleLogic';
import { BattleView } from './BattleView';
import { DebtLedgerView } from './DebtLedgerView';
import { matchAward } from './debtLedger';
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
  ChevronLeft, Loader2, LogOut, Edit2, Minus
} from 'lucide-react';

// --- View Props Interfaces ---
type View = 'home' | 'setup' | 'battle' | 'result' | 'history' | 'history_detail' | 'stats' | 'settings' | 'debt' | 'debt_award';

interface BaseProps {
  setCurrentView: (view: View) => void;
  setErrorMsg: (msg: string) => void;
}

interface HomeProps extends BaseProps {
  battleState: BattleState | null;
  setBattleState: (state: BattleState | null) => void;
  isSampleMode: boolean;
  setIsSampleMode: (val: boolean) => void;
}

type LoginProps = Pick<HomeProps, 'setIsSampleMode' | 'setErrorMsg'>;

interface SetupProps extends BaseProps {
  players: Player[];
  setBattleState: HomeProps['setBattleState'];
}

interface StatsProps extends Pick<BaseProps, 'setCurrentView'> {
  matches: Match[];
  players: Player[];
}

interface ResultProps extends StatsProps {
  finishedMatch: Match | null;
  recordAward: (match: Match) => void;
}

interface HistoryProps extends StatsProps {
  fetchData: () => Promise<void>;
  setSelectedMatch: (match: Match) => void;
  deleteMatch: (matchId: string) => Promise<boolean>;
}

interface SettingsProps extends BaseProps {
  players: Player[];
  savePlayers: (players: Player[]) => Promise<void>;
  isSampleMode: boolean;
  setIsSampleMode: HomeProps['setIsSampleMode'];
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
}

// --- Firebase Initialization ---
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
const STORAGE_KEY_SOUND_ENABLED = 'quiz_battle_sound_enabled';
const DEVICE_TEST_PARAM = 'deviceTest';
const isDeviceTestMode = new URLSearchParams(window.location.search).get(DEVICE_TEST_PARAM) === '1';

const getLocalDateString = () => {
  const today = new Date();
  const offset = today.getTimezoneOffset() * 60_000;
  return new Date(today.getTime() - offset).toISOString().slice(0, 10);
};

type AudioTestResult = '未実行' | Awaited<ReturnType<typeof playStartSound>>;

const readSoundPreference = () => {
  try {
    return localStorage.getItem(STORAGE_KEY_SOUND_ENABLED);
  } catch {
    return null;
  }
};

interface DeviceDiagnostics {
  device: 'iOS' | 'Android' | 'その他';
  launchMode: 'ブラウザ' | 'ホーム画面 / standalone';
  audioState: ReturnType<typeof getAudioState>;
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
  soundStorageValue: string | null;
  localDate: string;
  lastAudioTest: AudioTestResult;
  userAgent: string;
}

// --- Functions ---
const getMatchesRef = () => collection(db, 'families', FAMILY_ID, 'apps', 'quiz-battle', 'matches');
const getPlayersRef = () => collection(db, 'families', FAMILY_ID, 'apps', 'quiz-battle', 'players');
const debtEntriesRef = collection(db, 'families', FAMILY_ID, 'apps', 'quiz-battle', 'debtEntries');

const getDeviceDiagnostics = (lastAudioTest: AudioTestResult): DeviceDiagnostics => {
  const userAgent = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const device: DeviceDiagnostics['device'] = isIOS ? 'iOS' : /Android/.test(userAgent) ? 'Android' : 'その他';
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true;

  return {
    device,
    launchMode: isStandalone ? 'ホーム画面 / standalone' : 'ブラウザ',
    audioState: getAudioState(),
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    soundStorageValue: readSoundPreference(),
    localDate: getLocalDateString(),
    lastAudioTest,
    userAgent,
  };
};

const DEFAULT_PLAYERS: Player[] = [
  { id: 'p1', name: 'プレイヤー1', handicap: 'none', isActive: true },
  { id: 'p2', name: 'プレイヤー2', handicap: 'primary', isActive: true }
];

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
const LoginView = ({ setIsSampleMode, setErrorMsg }: LoginProps) => {
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
    <div className="flex h-full flex-col items-center overflow-y-auto bg-slate-50 p-4 sm:p-6">
      <div className="my-auto w-full max-w-sm shrink-0 rounded-3xl bg-white p-6 shadow-xl sm:max-w-[480px] sm:p-8">
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
    <div className="flex flex-col h-full overflow-y-auto bg-slate-50">
      <div className="shrink-0 bg-blue-600 text-white p-6 sm:px-10 lg:py-10 rounded-b-3xl shadow-md">
        <h1 className="text-3xl font-bold mb-2">クイズ対戦</h1>
        <p className="text-blue-100 opacity-90">親子や兄弟で楽しく学ぼう！</p>
      </div>

      <div className="flex-1 p-4 sm:p-8 flex flex-col gap-4">
        <div className={`grid gap-4 ${battleState ? 'sm:grid-cols-2' : 'sm:max-w-xl'}`}>
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
            className="w-full bg-blue-500 hover:bg-blue-600 active:scale-95 transition-transform text-white px-3 py-6 rounded-2xl shadow-lg flex items-center justify-center gap-2 text-lg sm:text-xl font-bold"
          >
            <Play className="w-8 h-8 shrink-0" /> 新しい対戦を始める
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <button onClick={() => setCurrentView('debt')}
            className="col-span-2 lg:col-span-1 w-full flex items-center justify-center gap-3 rounded-2xl bg-indigo-100 p-4 text-lg font-bold text-indigo-800">
            <Award className="w-6 h-6" /> 賞金・借金台帳
          </button>

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

          <button
            onClick={() => setCurrentView('settings')}
            className="col-span-2 lg:col-span-1 bg-white p-5 rounded-2xl shadow text-slate-700 hover:bg-slate-50 active:scale-95 transition-transform flex items-center justify-center gap-3"
          >
            <Settings className="w-6 h-6 text-slate-500" />
            <span className="font-bold">設定・プレイヤー</span>
          </button>
        </div>

        <div className="mt-auto bg-white p-4 rounded-xl sm:mt-2 sm:self-start sm:w-full sm:max-w-sm shadow-sm border border-slate-100 flex items-center justify-between">
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

const SetupView = ({ players, setBattleState, setCurrentView, setErrorMsg }: SetupProps) => {
  const [date, setDate] = useState(getLocalDateString);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [title, setTitle] = useState('');
  const [timeLimit, setTimeLimit] = useState(30);

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
    
    const newBattleState = createBattleState({
      date,
      title: finalTitle,
      category,
      timeLimitSec: timeLimit,
      players: { playerAId, playerBId },
      questioner: firstTurn,
      startTime: new Date().toISOString()
    }, pA, pB);

    setBattleState(newBattleState);
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(newBattleState));
    
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

      <div className="mx-auto grid w-full max-w-4xl gap-4 p-4 sm:grid-cols-2 sm:p-6">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-1" htmlFor="setup-date">対戦日</label>
          <input id="setup-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full min-w-0 border border-slate-200 rounded-lg p-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-1" htmlFor="setup-category">カテゴリ</label>
          <select id="setup-category" value={category} onChange={e => setCategory(e.target.value)} className="w-full min-w-0 border border-slate-200 rounded-lg p-3 bg-white appearance-none font-bold text-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 sm:col-span-2">
          <label className="block text-sm font-bold text-slate-700 mb-1" htmlFor="setup-title">タイトル (任意)</label>
          <input id="setup-title" type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder={`${category}クイズ ${date.replace(/-/g, '/')}`} className="w-full min-w-0 border border-slate-200 rounded-lg p-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-3">プレイヤー設定</label>
          <div className="flex flex-col items-stretch gap-2 mb-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <label htmlFor="setup-player-A" className="text-xs font-bold text-blue-500 mb-1 block">プレイヤーA (赤)</label>
              <select id="setup-player-A" value={playerAId} onChange={e => setPlayerAId(e.target.value)} className="w-full min-w-0 border-2 border-red-200 rounded-lg p-3 font-bold bg-red-50 text-red-900 focus:outline-none focus:ring-2 focus:ring-red-500">
                {activePlayers.map((p: Player) => <option key={p.id} value={p.id}>{p.name} {p.handicap === 'primary'?'(小)':p.handicap === 'junior'?'(中)':p.handicap === 'custom'?'(カ)':' '}</option>)}
              </select>
            </div>
            <span className="hidden font-bold text-slate-400 sm:mt-5 sm:inline">VS</span>
            <div className="min-w-0 flex-1">
              <label htmlFor="setup-player-B" className="text-xs font-bold text-blue-500 mb-1 block">プレイヤーB (青)</label>
              <select id="setup-player-B" value={playerBId} onChange={e => setPlayerBId(e.target.value)} className="w-full min-w-0 border-2 border-blue-200 rounded-lg p-3 font-bold bg-blue-50 text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500">
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

        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <label className="block text-sm font-bold text-slate-700 mb-1" htmlFor="setup-time">制限時間</label>
          <div className="flex items-center gap-4">
            <input id="setup-time" type="range" min="10" max="60" step="5" value={timeLimit} onChange={e => setTimeLimit(Number(e.target.value))} className="min-w-0 flex-1 h-11 cursor-pointer accent-blue-600" />
            <span className="font-bold text-xl w-16 text-right">{timeLimit}秒</span>
          </div>
        </div>

        <button onClick={handleStart} className="sm:col-span-2 sm:mx-auto sm:max-w-sm w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xl p-5 rounded-2xl shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2">
          <Play fill="currentColor" className="w-6 h-6" /> 対戦スタート！
        </button>
      </div>
    </div>
  );
};

const ResultView = ({ finishedMatch, matches, players, setCurrentView, recordAward }: ResultProps) => {
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
         <h2 className="text-4xl font-black mb-2 [overflow-wrap:anywhere]">
           {latestMatch.result === 'draw' ? '引き分け！' : `${latestMatch.result === 'playerA_win' ? pA?.name : pB?.name} の勝ち！`}
         </h2>
         <p className="opacity-90 [overflow-wrap:anywhere]">{latestMatch.title}</p>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 -mt-8 relative z-10 pb-10 sm:px-6">
         <div className="bg-white rounded-3xl shadow-xl p-6 border border-slate-100">
            <div className="flex justify-between items-center mb-6">
               <div className="text-center min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block text-sm font-bold text-red-500 mb-1">{pA?.name}</span>
                  <span className="text-xs text-slate-400 block -mt-1 mb-1 truncate">{latestMatch.handicapSnapshot?.playerA || getHandicapDisplay(pA)}</span>
                  <span className="text-5xl font-black sm:text-6xl text-slate-800">{latestMatch.finalScore.playerA}</span>
               </div>
               <div className="px-4 text-slate-300 font-black text-3xl mb-4">-</div>
               <div className="text-center min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block text-sm font-bold text-blue-500 mb-1">{pB?.name}</span>
                  <span className="text-xs text-slate-400 block -mt-1 mb-1 truncate">{latestMatch.handicapSnapshot?.playerB || getHandicapDisplay(pB)}</span>
                  <span className="text-5xl font-black sm:text-6xl text-slate-800">{latestMatch.finalScore.playerB}</span>
               </div>
            </div>

            <div className="text-center py-4 border-t border-slate-100 bg-slate-50 rounded-xl mb-6">
               <span className="text-sm font-bold text-slate-500 block mb-1">勝者</span>
               <span className="text-2xl font-black text-indigo-600 [overflow-wrap:anywhere]">
                 {latestMatch.result === 'draw' ? '引き分け' : 
                  latestMatch.result === 'playerA_win' ? pA?.name : pB?.name}
               </span>
            </div>

            {latestMatch.memo && (
              <div className="mb-2 p-4 bg-yellow-50 rounded-xl border border-yellow-100">
                <span className="text-xs font-bold text-yellow-600 block mb-1">📝 メモ</span>
                <p className="text-sm text-slate-700 whitespace-pre-wrap [overflow-wrap:anywhere]">{latestMatch.memo}</p>
              </div>
            )}

            <div className="grid gap-3 mt-6 sm:grid-cols-2">
               <button onClick={() => recordAward(latestMatch)}
                 className="w-full rounded-xl bg-indigo-100 p-4 font-bold text-indigo-800">
                 賞金を記録する
               </button>
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

const HistoryView = ({ matches, players, setCurrentView, fetchData, setSelectedMatch, deleteMatch }: HistoryProps) => {
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

  const openMatch = (match: Match) => {
    setSelectedMatch(match);
    setCurrentView('history_detail');
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
          className="w-full sm:max-w-xs bg-white border border-slate-200 rounded-lg p-3 font-bold text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="すべて">すべてのカテゴリ</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-10">
        {filteredMatches.length === 0 ? (
          <div className="text-center text-slate-400 mt-10 font-bold">履歴がありません</div>
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm lg:block">
              <table className="w-full table-fixed text-left text-sm">
                <thead className="border-b bg-slate-100 text-slate-600">
                  <tr>
                    <th scope="col" className="w-28 p-3">日付</th>
                    <th scope="col" className="w-24 p-3">カテゴリ</th>
                    <th scope="col" className="p-3">対戦名</th>
                    <th scope="col" className="w-1/5 p-3">プレイヤー</th>
                    <th scope="col" className="w-24 p-3">スコア</th>
                    <th scope="col" className="w-[13%] p-3">勝者</th>
                    <th scope="col" className="w-28 p-3">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 [overflow-wrap:anywhere]">
                  {filteredMatches.map(m => {
                    const nameA = players.find(p => p.id === m.players.playerAId)?.name || '不明';
                    const nameB = players.find(p => p.id === m.players.playerBId)?.name || '不明';

                    return (
                      <tr key={m.id} onClick={() => openMatch(m)} className="cursor-pointer hover:bg-slate-50">
                        <td className="p-3">{m.date.replace(/-/g, '/')}</td>
                        <td className="p-3 font-bold text-indigo-500">{m.category}</td>
                        <td className="p-3 font-bold">{m.title}</td>
                        <td className="p-3">{nameA} / {nameB}</td>
                        <td className="p-3 font-black tabular-nums">{m.finalScore.playerA} - {m.finalScore.playerB}</td>
                        <td className="p-3">{m.result === 'draw' ? '引き分け' : m.result === 'playerA_win' ? nameA : nameB}</td>
                        <td className="p-2">
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={e => { e.stopPropagation(); openMatch(m); }} aria-label={m.title + ' の詳細'} className="min-h-11 rounded-lg px-2 font-bold text-blue-700 hover:bg-blue-50">詳細</button>
                            <button type="button" onClick={e => handleDelete(e, m.id)} aria-label={m.title + ' を削除'} className="rounded-lg p-3 text-slate-500 hover:bg-red-50 hover:text-red-600">
                              <Trash2 className="h-5 w-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:hidden">
              {filteredMatches.map((m: Match) => {
                const pA = players.find((p: Player) => p.id === m.players.playerAId);
                const pB = players.find((p: Player) => p.id === m.players.playerBId);

                return (
                  <article key={m.id} className="relative min-w-0">
                    <button
                      onClick={() => openMatch(m)}
                      className="h-full w-full bg-white p-5 rounded-2xl shadow-sm border border-slate-100 flex flex-col min-w-0 text-left active:scale-95 transition-transform"
                    >
                      <div className="flex justify-between items-start mb-3 border-b border-slate-50 pb-3">
                        <div className="min-w-0 pr-16 [overflow-wrap:anywhere]">
                          <span className="text-xs font-bold text-indigo-500 bg-indigo-50 px-2 py-1 rounded-md">{m.category}</span>
                          <span className="text-xs text-slate-400 ml-2">{m.date.replace(/-/g, '/')}</span>
                          <h3 className="font-bold text-slate-800 mt-2 text-lg">{m.title}</h3>
                        </div>
                        <div className="absolute top-6 right-14 flex items-center">
                          {m.result !== 'draw' && <Award className="w-7 h-7 text-yellow-400 drop-shadow-sm shrink-0" />}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 mt-4 w-full">
                         <div className={`relative min-w-0 flex-1 flex flex-col items-center py-2 rounded-xl border-2 transition-colors ${m.result === 'playerA_win' ? 'bg-red-50 border-red-400 shadow-sm' : 'border-transparent'}`}>
                            {m.result === 'playerA_win' && <span className="text-base absolute -top-4">👑</span>}
                            <span className="text-xs font-bold text-slate-500 truncate w-full text-center px-1">{pA?.name || '不明'}</span>
                            <span className={`text-2xl font-black ${m.result === 'playerA_win' ? 'text-red-600' : 'text-slate-700'}`}>{m.finalScore.playerA}</span>
                         </div>
                         <span className="text-slate-300 font-black text-xl">-</span>
                         <div className={`relative min-w-0 flex-1 flex flex-col items-center py-2 rounded-xl border-2 transition-colors ${m.result === 'playerB_win' ? 'bg-blue-50 border-blue-400 shadow-sm' : 'border-transparent'}`}>
                            {m.result === 'playerB_win' && <span className="text-base absolute -top-4">👑</span>}
                            <span className="text-xs font-bold text-slate-500 truncate w-full text-center px-1">{pB?.name || '不明'}</span>
                            <span className={`text-2xl font-black ${m.result === 'playerB_win' ? 'text-blue-600' : 'text-slate-700'}`}>{m.finalScore.playerB}</span>
                         </div>
                      </div>
                    </button>
                    <button type="button" onClick={e => handleDelete(e, m.id)} aria-label={m.title + ' を削除'} className="absolute right-2 top-3 rounded-full p-3 text-slate-400 hover:bg-red-50 hover:text-red-500">
                      <Trash2 className="h-5 w-5" />
                    </button>
                  </article>
                );
              })}
            </div>
          </>
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
  setCurrentView: BaseProps['setCurrentView'];
  updateMatch: (match: Match) => Promise<boolean>;
  deleteMatch: (matchId: string) => Promise<boolean>;
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [editDate, setEditDate] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editMemo, setEditMemo] = useState('');

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

  const handleStartEdit = () => {
    setEditDate(match.date);
    setEditTitle(match.title);
    setEditCategory(match.category);
    setEditMemo(match.memo || '');
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    if (hasChanges) {
      if (!window.confirm('未保存の変更があります。\n破棄してもよろしいですか？')) return;
    }
    setIsEditing(false);
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

      <div className="grid min-h-0 content-start items-start gap-4 overflow-y-auto p-4 pb-10 lg:grid-cols-2">
        <div className="min-w-0 bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-100 relative [overflow-wrap:anywhere]">
          
          {isEditing ? (
            <div className="grid gap-4 mb-4 border-b border-slate-100 pb-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">対戦日</label>
                <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} className="w-full min-w-0 border border-slate-200 rounded-lg p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">カテゴリ</label>
                <select value={editCategory} onChange={e => setEditCategory(e.target.value)} className="w-full min-w-0 border border-slate-200 rounded-lg p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-bold text-slate-500 mb-1">タイトル</label>
                <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} className="w-full min-w-0 border border-slate-200 rounded-lg p-3 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-bold text-slate-500 mb-1">メモ</label>
                <textarea value={editMemo} onChange={e => setEditMemo(e.target.value)} className="w-full min-w-0 border border-slate-200 rounded-lg p-3 text-sm h-20 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="flex gap-3 mt-2 sm:col-span-2">
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
             <div className="min-w-0 flex-1 text-center">
                <span className="text-xs font-bold text-red-500 block">{pA?.name}</span>
                <span className="text-xs text-slate-400 block truncate">{match.handicapSnapshot?.playerA || getHandicapDisplay(pA)}</span>
                <span className="text-3xl font-black">{match.finalScore.playerA}</span>
             </div>
             <span className="text-slate-300 font-black text-xl">-</span>
             <div className="min-w-0 flex-1 text-center">
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
              <button onClick={handleStartEdit} disabled={isSaving} className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors">
                <Edit2 className="w-4 h-4" /> 編集
              </button>
              <button onClick={handleDelete} disabled={isSaving} className="flex-1 bg-red-50 hover:bg-red-100 text-red-600 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors">
                <Trash2 className="w-4 h-4" /> 削除
              </button>
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden min-w-0">
          <h4 className="font-bold text-slate-700 p-4 border-b bg-slate-50">ラウンド詳細</h4>
          {match.rounds.length > 0 ? (
            <table className="w-full table-fixed text-sm text-left [overflow-wrap:anywhere]">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="w-11 px-2 py-3 sm:w-14">No</th>
                  <th className="px-2 py-3">出題・回答</th>
                  <th className="w-12 px-2 py-3 text-center sm:w-16">結果</th>
                  <th className="w-16 px-2 py-3 text-right sm:w-24">得点</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {match.rounds.map((r: Round) => (
                  <tr key={r.roundNo} className="hover:bg-slate-50 transition-colors">
                    <td className="px-2 py-4 font-bold text-slate-500">{r.roundNo}</td>
                    <td className="px-2 py-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1 text-[10px] text-slate-400">
                          <Volume2 className="w-3 h-3 shrink-0"/> <span>{getPlayerName(r.questionerId)}</span>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] font-bold text-slate-700">
                          <span className="opacity-50">↳</span> <span>{getPlayerName(r.answererId)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-4 text-center">
                      {r.result === 'correct' && <Check className="w-5 h-5 text-emerald-500 mx-auto"/>}
                      {r.result === 'incorrect' && <X className="w-5 h-5 text-red-500 mx-auto"/>}
                      {r.result === 'timeout' && <Clock className="w-4 h-4 text-amber-500 mx-auto"/>}
                    </td>
                    <td className="px-2 py-4 font-bold text-indigo-600 text-right">
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


const StatsView = ({ matches, players, setCurrentView }: StatsProps) => {
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
  }).filter(d => d.totalGames > 0);

  // 勝利数ランキングでソート
  statsData.sort((a, b) => b.wins - a.wins);

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

      <div className="min-h-0 overflow-y-auto p-4 pb-10 sm:p-6">
        {statsData.length === 0 ? (
           <div className="text-center text-slate-400 mt-10 font-bold">データがありません</div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="min-w-0 bg-white p-4 lg:p-5 rounded-2xl shadow-sm border border-slate-100">
              <h3 className="font-bold text-slate-700 mb-4">ランキング・勝率比較</h3>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statsData} margin={{ top: 10, right: 10, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fontWeight: 'bold' }} angle={-35} textAnchor="end" height={86} tickMargin={8} />
                    <YAxis width={36} axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                    <RechartsTooltip cursor={{fill: '#f1f5f9'}} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Bar dataKey="winRate" fill="#3b82f6" radius={[6, 6, 0, 0]} name="勝率(%)" maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="min-w-0 bg-white p-4 lg:p-5 rounded-2xl shadow-sm border border-slate-100">
              <h3 className="font-bold text-slate-700 mb-4">プレイしたカテゴリ</h3>
              <div className="h-60 w-full sm:h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={70} paddingAngle={5} dataKey="value">
                      {pieData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: '12px', fontWeight: 'bold' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex items-center justify-center gap-2">
                <span className="text-3xl font-black text-slate-700">{matches.length}</span>
                <span className="text-xs font-bold text-slate-400">Games</span>
              </div>
            </div>

            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2 lg:grid-cols-3">
              <h3 className="font-bold text-slate-700 ml-1 col-span-full">カテゴリ別成績</h3>
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
                            <span className="font-bold text-slate-700 w-20 min-w-0 truncate">{player.name}</span>
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
          </div>
        )}
      </div>
    </div>
  );
};

const SettingsView = ({ players, savePlayers, setCurrentView, isSampleMode, setIsSampleMode, soundEnabled, setSoundEnabled, setErrorMsg }: SettingsProps) => {
  const [editingPlayers, setEditingPlayers] = useState<Player[]>(JSON.parse(JSON.stringify(players)));
  const [isSaving, setIsSaving] = useState(false);
  const [deviceDiagnostics, setDeviceDiagnostics] = useState<DeviceDiagnostics>(() => getDeviceDiagnostics('未実行'));
  const [audioTestResult, setAudioTestResult] = useState<AudioTestResult>('未実行');
  const [isTestingAudio, setIsTestingAudio] = useState(false);

  const refreshDeviceDiagnostics = useCallback((lastAudioTest?: AudioTestResult) => {
    if (isDeviceTestMode) {
      setDeviceDiagnostics(previous => getDeviceDiagnostics(lastAudioTest ?? previous.lastAudioTest));
    }
  }, []);

  useEffect(() => {
    if (!isDeviceTestMode) return;

    const handleEnvironmentChange = () => refreshDeviceDiagnostics();
    document.addEventListener('visibilitychange', handleEnvironmentChange);
    window.addEventListener('focus', handleEnvironmentChange);
    window.addEventListener('blur', handleEnvironmentChange);
    window.addEventListener('pageshow', handleEnvironmentChange);
    return () => {
      document.removeEventListener('visibilitychange', handleEnvironmentChange);
      window.removeEventListener('focus', handleEnvironmentChange);
      window.removeEventListener('blur', handleEnvironmentChange);
      window.removeEventListener('pageshow', handleEnvironmentChange);
    };
  }, [refreshDeviceDiagnostics]);

  const activeEditingPlayers = editingPlayers.filter(p => p.isActive !== false);

  const updatePlayer = (id: string, field: keyof Player, value: string | number) => {
    setEditingPlayers(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  const adjustCustomValue = (id: string, field: 'customScoreOffset' | 'customTimeOffset', amount: number) => {
    setEditingPlayers(prev => prev.map(p => {
      if (p.id === id) {
        const currentValue = Number(p[field]) || 0;
        return { ...p, [field]: currentValue + amount };
      }
      return p;
    }));
  };

  const addPlayer = () => {
    const newP: Player = { id: 'p_' + Date.now(), name: 'なまえ', handicap: 'none', isActive: true, customScoreOffset: 0, customTimeOffset: 0 };
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
    // 保存時に string 型になっている可能性がある offset を number 型に変換する
    const playersToSave = editingPlayers.map(p => ({
      ...p,
      customScoreOffset: Number(p.customScoreOffset) || 0,
      customTimeOffset: Number(p.customTimeOffset) || 0,
    }));
    await savePlayers(playersToSave);
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

  const handleAudioTest = async (event: React.MouseEvent<HTMLButtonElement>) => {
    setIsTestingAudio(true);
    const result = await playStartSound(event.nativeEvent);
    setAudioTestResult(result);
    refreshDeviceDiagnostics(result);
    setIsTestingAudio(false);
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 relative">
      <div className="bg-white p-4 border-b flex items-center sticky top-0 z-10 shadow-sm">
        <button onClick={() => setCurrentView('home')} className="p-2 -ml-2 text-slate-500" disabled={isSaving}>
          <X className="w-6 h-6" />
        </button>
        <h2 className="text-xl font-bold mx-auto pr-8">設定</h2>
      </div>

      <div className="grid min-h-0 flex-1 content-start items-start gap-6 overflow-y-auto p-4 sm:p-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-100">
          <div className="flex justify-between items-center mb-4">
             <h3 className="font-bold text-slate-700 flex items-center gap-2"><User className="w-5 h-5"/> プレイヤー管理</h3>
             <button onClick={addPlayer} className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1 rounded-full flex items-center gap-1">
               <Plus className="w-4 h-4"/> 追加
             </button>
          </div>
          
          <div className="flex flex-col gap-4">
            {activeEditingPlayers.map((p, index) => (
              <div key={p.id} className={`relative flex flex-col gap-3 ${index !== 0 ? 'pt-6 border-t border-slate-100' : ''}`}>
                 <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <input 
                        type="text" 
                        value={p.name} 
                        onChange={e => updatePlayer(p.id, 'name', e.target.value)} 
                        className="w-full font-bold text-lg p-3 rounded-lg border border-slate-200 mb-3 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="プレイヤー名"
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
                        <div className="flex flex-col gap-4 mt-4 w-full bg-slate-50 p-2 sm:p-4 rounded-xl border border-slate-200">
                          {/* 初期スコア設定 (クイックボタン + スコア表示) */}
                          <div>
                            <label className="block text-xs font-bold text-slate-500 mb-2 text-center">
                              初期スコア
                            </label>
                            <div className="flex flex-col gap-2">
                              <div className="flex justify-center gap-2">
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customScoreOffset', -1)}
                                  className="w-11 h-12 shrink-0 flex items-center justify-center bg-white border border-slate-300 rounded-xl active:bg-slate-100 text-slate-700 shadow-sm"
                                >
                                  <Minus className="w-6 h-6" />
                                </button>
                                <div className="w-24 min-w-0 h-12 flex items-center justify-center bg-white border border-slate-300 rounded-xl font-black text-2xl text-slate-800 shadow-inner">
                                  {(Number(p.customScoreOffset) || 0) > 0 ? '+' : ''}
                                  {Number(p.customScoreOffset) || 0}
                                </div>
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customScoreOffset', 1)}
                                  className="w-11 h-12 shrink-0 flex items-center justify-center bg-white border border-slate-300 rounded-xl active:bg-slate-100 text-slate-700 shadow-sm"
                                >
                                  <Plus className="w-6 h-6" />
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="w-full h-px bg-slate-200 my-1"></div>

                          {/* 回答時間増減設定 (クイックボタン + 時間表示) */}
                          <div>
                            <label className="block text-xs font-bold text-slate-500 mb-2 text-center">
                              回答時間増減
                            </label>
                            <div className="flex flex-col gap-3">
                              <div className="flex justify-center gap-2">
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customTimeOffset', -1)}
                                  className="w-11 h-12 shrink-0 flex items-center justify-center bg-white border border-slate-300 rounded-xl active:bg-slate-100 text-slate-700 shadow-sm"
                                >
                                  <Minus className="w-6 h-6" />
                                </button>
                                <div className="w-32 min-w-0 h-12 flex items-center justify-center bg-white border border-slate-300 rounded-xl font-black text-2xl text-slate-800 shadow-inner">
                                  {(Number(p.customTimeOffset) || 0) > 0 ? '+' : ''}
                                  {Number(p.customTimeOffset) || 0}秒
                                </div>
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customTimeOffset', 1)}
                                  className="w-11 h-12 shrink-0 flex items-center justify-center bg-white border border-slate-300 rounded-xl active:bg-slate-100 text-slate-700 shadow-sm"
                                >
                                  <Plus className="w-6 h-6" />
                                </button>
                              </div>

                              <div className="grid grid-cols-2 gap-2 min-[375px]:grid-cols-4">
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customTimeOffset', -10)}
                                  className="h-11 bg-white border border-slate-300 rounded-lg text-sm font-bold text-slate-600 active:bg-slate-100 shadow-sm transition-colors"
                                >
                                  -10秒
                                </button>
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customTimeOffset', -5)}
                                  className="h-11 bg-white border border-slate-300 rounded-lg text-sm font-bold text-slate-600 active:bg-slate-100 shadow-sm transition-colors"
                                >
                                  -5秒
                                </button>
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customTimeOffset', 5)}
                                  className="h-11 bg-white border border-slate-300 rounded-lg text-sm font-bold text-slate-600 active:bg-slate-100 shadow-sm transition-colors"
                                >
                                  +5秒
                                </button>
                                <button
                                  onClick={() => adjustCustomValue(p.id, 'customTimeOffset', 10)}
                                  className="h-11 bg-white border border-slate-300 rounded-lg text-sm font-bold text-slate-600 active:bg-slate-100 shadow-sm transition-colors"
                                >
                                  +10秒
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <button onClick={() => removePlayer(p.id)} className="shrink-0 p-2 text-red-400 hover:bg-red-50 rounded-lg transition-colors ml-auto self-start mt-1">
                      <Trash2 className="w-5 h-5" />
                    </button>
                 </div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-100">
           <h3 className="font-bold text-slate-700 mb-4">システム設定</h3>
           <div className="flex items-center justify-between py-2 border-b border-slate-50">
              <div className="flex items-center gap-3">
                {soundEnabled ? <Volume2 className="w-5 h-5 text-slate-500"/> : <VolumeX className="w-5 h-5 text-slate-400"/>}
                <span className="font-bold text-slate-700">効果音</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="効果音"
                aria-checked={soundEnabled}
                onClick={event => {
                  const nextEnabled = !soundEnabled;
                  setAudioEnabled(nextEnabled);
                  setSoundEnabled(nextEnabled);
                  setAudioTestResult('未実行');
                  if (nextEnabled) {
                    void ensureAudioReady(event.nativeEvent).then(() => refreshDeviceDiagnostics());
                  }
                  if (isDeviceTestMode) window.setTimeout(() => refreshDeviceDiagnostics(), 0);
                }}
                className="flex min-h-11 shrink-0 items-center gap-2 px-1 text-sm font-bold text-slate-700"
              >
                {soundEnabled ? 'ON' : 'OFF'}
                <span aria-hidden="true" className={`w-14 h-8 rounded-full relative transition-colors ${soundEnabled ? 'bg-blue-500' : 'bg-slate-300'}`}>
                  <span className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-transform ${soundEnabled ? 'left-7' : 'left-1'}`} />
                </span>
              </button>
           </div>
           {soundEnabled && (
             <button
               type="button"
               disabled={isTestingAudio}
               onClick={handleAudioTest}
               className="mt-4 min-h-11 w-full rounded-xl bg-blue-50 p-3 text-sm font-bold text-blue-700 transition-colors hover:bg-blue-100 active:scale-[0.98]"
             >
               効果音を試聴する
             </button>
           )}
           <p role="status" className="mt-2 text-sm text-slate-700 empty:hidden">
             {isTestingAudio ? '音声を準備中…' : soundEnabled && audioTestResult !== '未実行' ? audioTestResult : ''}
           </p>

           {isDeviceTestMode && (
             <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-slate-700">
               <h4 className="mb-3 font-black text-violet-800">実機確認モード</h4>
               <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 break-words">
                 <dt className="font-bold text-slate-500">端末</dt><dd>{deviceDiagnostics.device}</dd>
                 <dt className="font-bold text-slate-500">起動方法</dt><dd>{deviceDiagnostics.launchMode}</dd>
                 <dt className="font-bold text-slate-500">AudioContext</dt><dd>{deviceDiagnostics.audioState}</dd>
                 <dt className="font-bold text-slate-500">表示状態</dt><dd>{deviceDiagnostics.visibilityState} / {deviceDiagnostics.hasFocus ? 'フォーカスあり' : 'フォーカスなし'}</dd>
                 <dt className="font-bold text-slate-500">効果音設定</dt><dd>{soundEnabled ? 'ON' : 'OFF'}</dd>
                 <dt className="font-bold text-slate-500">保存値</dt><dd>{deviceDiagnostics.soundStorageValue ?? '未保存'}</dd>
                 <dt className="font-bold text-slate-500">ローカル日付</dt><dd>{deviceDiagnostics.localDate}</dd>
                 <dt className="font-bold text-slate-500">最終音声テスト</dt><dd>{deviceDiagnostics.lastAudioTest}</dd>
               </dl>
               <p className="mt-3 break-all text-[10px] leading-relaxed text-slate-500">UA: {deviceDiagnostics.userAgent}</p>
               <div className="mt-4 grid gap-2 sm:grid-cols-2">
                 <button
                   type="button"
                   onClick={() => refreshDeviceDiagnostics()}
                   className="rounded-lg bg-white px-3 py-2 font-bold text-violet-700 shadow-sm ring-1 ring-violet-200 active:scale-[0.98]"
                 >
                   状態更新
                 </button>
                 <button
                   type="button"
                   disabled={isTestingAudio}
                   onClick={handleAudioTest}
                   className="rounded-lg bg-violet-600 px-3 py-2 font-bold text-white shadow-sm active:scale-[0.98]"
                 >
                   開始音テスト
                 </button>
               </div>
             </div>
           )}
           
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
      
      <div className="shrink-0 p-4 bg-white border-t shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.05)]">
        <button 
          onClick={handleSave} 
          disabled={isSaving}
          className="mx-auto w-full max-w-sm bg-slate-800 hover:bg-slate-900 disabled:bg-slate-400 text-white font-bold text-xl p-4 rounded-xl shadow-md active:scale-95 transition-all flex items-center justify-center gap-2"
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
  const [soundEnabled, setSoundEnabled] = useState(() => readSoundPreference() !== 'false');
  
  const [currentView, setCurrentView] = useState<View>('home');
  
  const [players, setPlayers] = useState<Player[]>(DEFAULT_PLAYERS);
  const [matches, setMatches] = useState<Match[]>([]);
  const cloudRequestId = useRef(0);
  
  const [savedBattleState, setBattleState] = useState(
    () => parseSavedBattleState(localStorage.getItem(STORAGE_KEY_STATE)),
  );
  const battleState = savedBattleState ?? null;
  const hasInvalidBattleState = savedBattleState === undefined;
  const [finishedMatch, setFinishedMatch] = useState<Match | null>(null);
  const [awardSeed, setAwardSeed] = useState<ReturnType<typeof matchAward> | null>(null);
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

  const loadSampleData = () => {
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
  };

  const handleSampleModeChange = (enabled: boolean) => {
    if (enabled === isSampleMode) return;
    cloudRequestId.current++;
    if (enabled) {
      loadSampleData();
    } else {
      setPlayers(DEFAULT_PLAYERS);
      setMatches([]);
    }
    setIsSampleMode(enabled);
  };

  const fetchCloudData = useCallback(() => {
    const requestId = cloudRequestId.current + 1;
    cloudRequestId.current = requestId;
    return getDocs(getPlayersRef()).then(playerSnap => {
      if (requestId !== cloudRequestId.current) return;
      const fetchedPlayers: Player[] = [];
      playerSnap.forEach(doc => fetchedPlayers.push(doc.data() as Player));
      if (fetchedPlayers.length > 0) setPlayers(fetchedPlayers);
      return getDocs(getMatchesRef());
    }).then(matchSnap => {
      if (!matchSnap || requestId !== cloudRequestId.current) return;
      const fetchedMatches: Match[] = [];
      matchSnap.forEach(doc => fetchedMatches.push(doc.data() as Match));
      fetchedMatches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setMatches(fetchedMatches);
    }).catch(error => {
      console.error("Fetch Data Error:", error);
    });
  }, []);

  const fetchData = async () => {
    if (isSampleMode) loadSampleData();
    else if (user) await fetchCloudData();
  };

  useEffect(() => {
    if (!user || isSampleMode) return;
    void fetchCloudData();
    return () => { cloudRequestId.current++; };
  }, [fetchCloudData, isSampleMode, user]);

  useEffect(() => {
    if (hasInvalidBattleState) localStorage.removeItem(STORAGE_KEY_STATE);
  }, [hasInvalidBattleState]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SOUND_ENABLED, String(soundEnabled));
    } catch {
      // The setting still applies for the current session.
    }
    setAudioEnabled(soundEnabled);
  }, [soundEnabled]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => { void ensureAudioReady(event); };
    const handleVisibility = () => {
      if (document.hidden) cancelSounds();
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', cancelSounds);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', cancelSounds);
      setAudioEnabled(false);
    };
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
      <div className="w-full max-w-6xl mx-auto h-dvh bg-slate-100 overflow-hidden shadow-2xl relative select-none font-sans text-slate-800">
        <ErrorToast msg={appError} onClose={() => setAppError('')} />
        <LoginView setIsSampleMode={handleSampleModeChange} setErrorMsg={setAppError} />
      </div>
    );
  }

  return (
    <div className={`w-full ${currentView === 'debt' || currentView === 'debt_award' ? 'max-w-7xl h-screen' : 'max-w-6xl h-dvh'} mx-auto bg-slate-100 overflow-hidden shadow-2xl relative select-none font-sans text-slate-800 flex flex-col`}>
      {isSampleMode && (
        <div className="bg-amber-500 text-white text-[11px] font-bold py-1 px-4 text-center z-50 flex items-center justify-center gap-1 shrink-0">
          <AlertCircle className="w-3 h-3" /> サンプルモード中（この端末にのみ保存されます）
        </div>
      )}
      
      <div className="min-h-0 flex-1 relative overflow-hidden">
        <ErrorToast msg={appError} onClose={() => setAppError('')} />
        
        {currentView === 'home' && (
          <HomeView 
            battleState={battleState} 
            setBattleState={setBattleState}
            setCurrentView={setCurrentView} 
            isSampleMode={isSampleMode} 
            setIsSampleMode={handleSampleModeChange}
            setErrorMsg={setAppError}
          />
        )}
        {currentView === 'setup' && (
          <SetupView 
            players={players} 
            setBattleState={setBattleState} 
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
            storageKey={STORAGE_KEY_STATE}
            setErrorMsg={setAppError} 
          />
        )}
        {currentView === 'result' && (
          <ResultView 
            finishedMatch={finishedMatch}
            matches={matches} 
            players={players} 
            setCurrentView={setCurrentView} 
            recordAward={match => {
              setAwardSeed(matchAward(match, players));
              setCurrentView('debt_award');
            }}
          />
        )}
        {(currentView === 'debt' || currentView === 'debt_award') && (
          <DebtLedgerView
            key={isSampleMode ? 'sample' : user?.uid}
            ledger={isSampleMode ? null : debtEntriesRef}
            actor={isSampleMode ? 'sample' : user!.uid}
            seed={currentView === 'debt_award' ? awardSeed : null}
            today={getLocalDateString()}
            onExit={() => setCurrentView(currentView === 'debt_award' ? 'result' : 'home')}
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
            match={matches.find(match => match.id === selectedMatch?.id) ?? null}
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
            setIsSampleMode={handleSampleModeChange}
            soundEnabled={soundEnabled} 
            setSoundEnabled={setSoundEnabled}
            setErrorMsg={setAppError} 
          />
        )}
      </div>
    </div>
  );
}
