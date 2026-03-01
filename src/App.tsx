import './styles/app.css';
import { ProviderProvider } from './context/ProviderContext';
import { ChatProvider } from './context/ChatContext';
import { ModelProvider } from './context/ModelContext';
import AppLayout from './components/layout/AppLayout';

function App() {
  return (
    <ProviderProvider>
      <ModelProvider>
        <ChatProvider>
          <AppLayout />
        </ChatProvider>
      </ModelProvider>
    </ProviderProvider>
  );
}

export default App;
