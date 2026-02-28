import ChatInput from './ChatInput';

interface WelcomeViewProps {
  onSend: (content: string) => void;
}

export default function WelcomeView({ onSend }: WelcomeViewProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl font-light text-text-primary text-center mb-3">
          What can we help with?
        </h1>
        <p className="text-sm text-text-tertiary text-center mb-8">
          Chat with Cerebro or ask an expert — we'll plan, execute, and follow up.
        </p>
        <ChatInput onSend={onSend} />
      </div>
    </div>
  );
}
