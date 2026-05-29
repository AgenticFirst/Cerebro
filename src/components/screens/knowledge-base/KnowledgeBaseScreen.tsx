import PageTreeSidebar from './PageTreeSidebar';
import PageEditor from './PageEditor';

/**
 * Knowledge Base — a Notion-style notes app. Two-pane layout: a page tree on
 * the left and the block editor on the right (mirrors FilesScreen/SettingsScreen).
 */
export default function KnowledgeBaseScreen() {
  return (
    <div className="flex flex-1 min-h-0">
      <PageTreeSidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <PageEditor />
      </div>
    </div>
  );
}
