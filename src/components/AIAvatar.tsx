import { Volume2, VolumeX } from 'lucide-react';

interface AIAvatarProps {
  isListening: boolean;
  isSpeaking: boolean;
  isConnected: boolean;
  onToggle: () => void;
}

export const AIAvatar = ({ isListening, isSpeaking, isConnected, onToggle }: AIAvatarProps) => {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-32 h-32 flex items-center justify-center">
        <div
          className={`
            absolute inset-0 rounded-full
            bg-gradient-to-br from-blue-400 via-cyan-400 to-blue-500
            transition-all duration-700 ease-in-out
            ${isSpeaking ? 'scale-110 opacity-30' : 'scale-100 opacity-40'}
          `}
          style={{
            animation: isSpeaking ? 'wave 2s ease-in-out infinite' : 'pulse 3s ease-in-out infinite',
          }}
        />

        <div
          className={`
            absolute inset-2 rounded-full
            bg-gradient-to-br from-cyan-400 via-blue-400 to-cyan-500
            transition-all duration-500 ease-in-out
            ${isSpeaking ? 'scale-105 opacity-50' : 'scale-100 opacity-60'}
          `}
          style={{
            animation: isSpeaking ? 'wave 1.5s ease-in-out infinite 0.2s' : 'pulse 3s ease-in-out infinite 0.5s',
          }}
        />

        <div
          className={`
            absolute inset-4 rounded-full
            bg-gradient-to-br from-blue-500 via-cyan-500 to-blue-600
            transition-all duration-300 ease-in-out
            ${isSpeaking ? 'scale-110 opacity-80' : 'scale-100 opacity-90'}
          `}
          style={{
            animation: isSpeaking ? 'wave 1s ease-in-out infinite 0.4s' : 'pulse 3s ease-in-out infinite 1s',
          }}
        />

        <div
          className={`
            relative w-16 h-16 rounded-full
            bg-gradient-to-br from-blue-600 via-cyan-600 to-blue-700
            shadow-2xl
            transition-all duration-200
            ${isSpeaking ? 'scale-110' : 'scale-100'}
          `}
        >
          {isSpeaking && (
            <div className="absolute inset-0 rounded-full bg-white/20 animate-ping" />
          )}
        </div>

        <div className={`
          absolute -bottom-2 -right-2 w-6 h-6 rounded-full
          transition-all duration-200 shadow-lg border-2 border-white
          ${isConnected ? 'bg-emerald-500' : 'bg-slate-400'}
        `}>
          {isConnected && (
            <div className="absolute inset-0 rounded-full bg-emerald-400/50 animate-pulse" />
          )}
        </div>
      </div>

      <button
        onClick={onToggle}
        className={`
          px-4 py-2 rounded-full text-sm font-medium
          transition-all duration-200
          backdrop-blur-xl shadow-lg
          ${isListening
            ? 'bg-red-500 text-white hover:bg-red-600'
            : 'bg-white/90 text-slate-700 hover:bg-white'
          }
        `}
      >
        <div className="flex items-center gap-2">
          {isListening ? (
            <>
              <VolumeX className="w-4 h-4" />
              <span>Stop Listening</span>
            </>
          ) : (
            <>
              <Volume2 className="w-4 h-4" />
              <span>Ask AI</span>
            </>
          )}
        </div>
      </button>

      {isListening && (
        <div className="px-3 py-1 bg-red-500/90 text-white text-xs rounded-full backdrop-blur-sm animate-pulse">
          Listening...
        </div>
      )}
      {isSpeaking && !isListening && (
        <div className="px-3 py-1 bg-blue-500/90 text-white text-xs rounded-full backdrop-blur-sm animate-fadeIn">
          AI is speaking...
        </div>
      )}

      <style>{`
        @keyframes wave {
          0%, 100% {
            transform: scale(1);
            opacity: 0.6;
          }
          50% {
            transform: scale(1.2);
            opacity: 0.3;
          }
        }
      `}</style>
    </div>
  );
};
