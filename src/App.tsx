import './styles/app.css';
import { ChatProvider } from './context/ChatContext';
import { ModelProvider } from './context/ModelContext';
import AppLayout from './components/layout/AppLayout';

function App() {
  return (
    <ModelProvider>
      <ChatProvider>
        <AppLayout />
      </ChatProvider>
    </ModelProvider>
  );
}

export default App;
