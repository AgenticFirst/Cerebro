import ChatInput from './ChatInput';

interface WelcomeViewProps {
  onSend: (content: string) => void;
}

export default function WelcomeView({ onSend }: WelcomeViewProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl font-light text-text-primary text-center mb-8">
          What are you thinking?
        </h1>
        <ChatInput onSend={onSend} />
      </div>
    </div>
  );
}
