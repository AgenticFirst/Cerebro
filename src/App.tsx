import './styles/app.css';
import { ProviderProvider } from './context/ProviderContext';
import { ChatProvider } from './context/ChatContext';
import { MemoryProvider } from './context/MemoryContext';
import { ExpertProvider } from './context/ExpertContext';
import { SkillProvider } from './context/SkillContext';
import { RoutineProvider } from './context/RoutineContext';
import { ApprovalProvider } from './context/ApprovalContext';
import { TaskProvider } from './context/TaskContext';
import { ToastProvider } from './context/ToastContext';
import { VoiceProvider } from './context/VoiceContext';
import { SandboxProvider } from './context/SandboxContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { ThemeProvider } from './context/ThemeContext';
import { UIPreferencesProvider } from './context/UIPreferencesContext';
import AppLayout from './components/layout/AppLayout';
import ToastContainer from './components/ui/Toast';

function App() {
  return (
    <ToastProvider>
      <ThemeProvider>
      <UIPreferencesProvider>
      <ProviderProvider>
        <SandboxProvider>
          <FeatureFlagsProvider>
            <MemoryProvider>
              <ExpertProvider>
                <SkillProvider>
                <RoutineProvider>
                  <ApprovalProvider>
                    <TaskProvider>
                      <ChatProvider>
                        <VoiceProvider>
                          <AppLayout />
                        </VoiceProvider>
                      </ChatProvider>
                    </TaskProvider>
                  </ApprovalProvider>
                </RoutineProvider>
                </SkillProvider>
              </ExpertProvider>
            </MemoryProvider>
          </FeatureFlagsProvider>
        </SandboxProvider>
      </ProviderProvider>
      </UIPreferencesProvider>
      </ThemeProvider>
      <ToastContainer />
    </ToastProvider>
  );
}

export default App;
