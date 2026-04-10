import './styles/app.css';
import { ProviderProvider } from './context/ProviderContext';
import { ChatProvider } from './context/ChatContext';
import { MemoryProvider } from './context/MemoryContext';
import { ExpertProvider } from './context/ExpertContext';
import { SkillProvider } from './context/SkillContext';
import { RoutineProvider } from './context/RoutineContext';
import { ApprovalProvider } from './context/ApprovalContext';
import { ToastProvider } from './context/ToastContext';
import AppLayout from './components/layout/AppLayout';
import ToastContainer from './components/ui/Toast';

function App() {
  return (
    <ToastProvider>
      <ProviderProvider>
        <MemoryProvider>
          <ExpertProvider>
            <SkillProvider>
            <RoutineProvider>
              <ApprovalProvider>
                <ChatProvider>
                  <AppLayout />
                </ChatProvider>
              </ApprovalProvider>
            </RoutineProvider>
            </SkillProvider>
          </ExpertProvider>
        </MemoryProvider>
      </ProviderProvider>
      <ToastContainer />
    </ToastProvider>
  );
}

export default App;
