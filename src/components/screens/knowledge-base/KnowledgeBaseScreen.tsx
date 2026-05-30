import PageTreeSidebar from './PageTreeSidebar';
import PageEditor from './PageEditor';
import { AskAiPanel } from './AskAiPanel';
import { AskAiButton } from './AskAiButton';
import { useKnowledgeAi } from '../../../context/KnowledgeAiContext';

/**
 * Knowledge Base — a Notion-style notes app. Three flexible panes: the page
 * tree, the block editor, and (when open) the Ask AI panel. The panel is a flex
 * sibling — not an overlay — so opening it shrinks the editor pane and the page
 * content stays fully visible and centered in the remaining space.
 */
export default function KnowledgeBaseScreen() {
  const { isOpen } = useKnowledgeAi();

  return (
    <div className="flex flex-1 min-h-0">
      <PageTreeSidebar />
      {/* relative so the floating Ask AI button pins to the pane's bottom-right
          (it lives outside the editor's scroll container, so it never scrolls). */}
      <div className="relative flex-1 min-w-0 flex flex-col">
        {/* Draggable window strip above the editor */}
        <div className="app-drag-region h-11 flex-shrink-0" />
        <div className="flex-1 min-h-0">
          <PageEditor />
        </div>
        <AskAiButton />
      </div>
      {isOpen && <AskAiPanel />}
    </div>
  );
}
