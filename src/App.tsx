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
import { QualityProvider } from './context/QualityContext';
import { EngineProvider } from './context/EngineContext';
import { UIPreferencesProvider } from './context/UIPreferencesContext';
import { MarkdownDocumentProvider } from './context/MarkdownDocumentContext';
import { ChatFilePreviewProvider } from './context/ChatFilePreviewContext';
import { FilesProvider } from './context/FilesContext';
import { KnowledgeBaseProvider } from './context/KnowledgeBaseContext';
import { KnowledgeAiProvider } from './context/KnowledgeAiContext';
import { NewsProvider } from './context/NewsContext';
import { CalendarProvider } from './context/CalendarContext';
import { UpdateProvider } from './context/UpdateContext';
import { OnboardingProvider } from './context/OnboardingContext';
import AppLayout from './components/layout/AppLayout';
import ToastContainer from './components/ui/Toast';
import OnboardingTour from './components/onboarding/OnboardingTour';
import RestoreCompletionWatcher from './components/backup/RestoreCompletionWatcher';

function App() {
  return (
    <ToastProvider>
      <OnboardingProvider>
        <ThemeProvider>
          <QualityProvider>
            <EngineProvider>
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
                                        <KnowledgeBaseProvider>
                                          <KnowledgeAiProvider>
                                            <NewsProvider>
                                              <CalendarProvider>
                                                <VoiceProvider>
                                                  <MarkdownDocumentProvider>
                                                    <ChatFilePreviewProvider>
                                                      <AppLayout />
                                                      <OnboardingTour />
                                                    </ChatFilePreviewProvider>
                                                  </MarkdownDocumentProvider>
                                                </VoiceProvider>
                                              </CalendarProvider>
                                            </NewsProvider>
                                          </KnowledgeAiProvider>
                                        </KnowledgeBaseProvider>
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
            </EngineProvider>
          </QualityProvider>
        </ThemeProvider>
      </OnboardingProvider>
      <ToastContainer />
      <RestoreCompletionWatcher />
    </ToastProvider>
  );
}

export default App;
