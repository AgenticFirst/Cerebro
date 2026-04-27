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
import { MarkdownDocumentProvider } from './context/MarkdownDocumentContext';
import { FilesProvider } from './context/FilesContext';
import { UpdateProvider } from './context/UpdateContext';
import { OnboardingProvider } from './context/OnboardingContext';
import AppLayout from './components/layout/AppLayout';
import ToastContainer from './components/ui/Toast';
import OnboardingTour from './components/onboarding/OnboardingTour';

function App() {
  return (
    <ToastProvider>
      <OnboardingProvider>
      <ThemeProvider>
      <UIPreferencesProvider>
      <UpdateProvider>
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
                        <FilesProvider>
                          <VoiceProvider>
                            <MarkdownDocumentProvider>
                              <AppLayout />
                              <OnboardingTour />
                            </MarkdownDocumentProvider>
                          </VoiceProvider>
                        </FilesProvider>
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
      </UpdateProvider>
      </UIPreferencesProvider>
      </ThemeProvider>
      </OnboardingProvider>
      <ToastContainer />
    </ToastProvider>
  );
}

export default App;
