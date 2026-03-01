import './styles/app.css';
import { ProviderProvider } from './context/ProviderContext';
import { ChatProvider } from './context/ChatContext';
import { ModelProvider } from './context/ModelContext';
import { MemoryProvider } from './context/MemoryContext';
import AppLayout from './components/layout/AppLayout';

function App() {
  return (
    <ProviderProvider>
      <ModelProvider>
        <MemoryProvider>
          <ChatProvider>
            <AppLayout />
          </ChatProvider>
        </MemoryProvider>
      </ModelProvider>
    </ProviderProvider>
  );
}

export default App;
