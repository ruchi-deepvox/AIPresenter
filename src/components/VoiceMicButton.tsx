import { Mic, MicOff } from 'lucide-react';

interface VoiceMicButtonProps {
  isListening: boolean;
  isSpeaking: boolean;
  isConnected: boolean;
  onToggle: () => void;
}

export const VoiceMicButton = ({ isListening, isSpeaking, isConnected, onToggle }: VoiceMicButtonProps) => {
  return (
    <button
      onClick={onToggle}
      className={`
        relative group
        w-16 h-16 rounded-full
        flex items-center justify-center
        transition-all duration-300 ease-out
        backdrop-blur-xl
        ${isListening
          ? 'bg-blue-500/90 shadow-lg shadow-blue-500/50 scale-110'
          : 'bg-white/80 hover:bg-white/90 shadow-lg hover:shadow-xl'
        }
      `}
      aria-label={isListening ? 'Stop listening' : 'Start listening'}
    >
      {isSpeaking && (
        <div className="absolute inset-0 rounded-full animate-ping bg-blue-400/50" />
      )}

      <div className={`
        absolute inset-0 rounded-full
        transition-all duration-300
        ${isSpeaking ? 'animate-pulse bg-blue-400/30' : ''}
      `} />

      {isListening ? (
        <Mic className="w-7 h-7 text-white relative z-10" strokeWidth={2} />
      ) : (
        <MicOff className="w-7 h-7 text-slate-700 relative z-10 group-hover:text-slate-900 transition-colors" strokeWidth={2} />
      )}

      <div className={`
        absolute -bottom-1 -right-1 w-4 h-4 rounded-full
        transition-all duration-200
        ${isConnected ? 'bg-emerald-500' : 'bg-slate-300'}
      `} />

      {isSpeaking && (
        <div className="absolute inset-0 rounded-full">
          <div className="absolute inset-0 rounded-full animate-ping bg-blue-400/30" style={{ animationDuration: '1s' }} />
          <div className="absolute inset-0 rounded-full animate-ping bg-blue-400/20" style={{ animationDuration: '1.5s' }} />
        </div>
      )}
    </button>
  );
};
