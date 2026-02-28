import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Components } from 'react-markdown';

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');

    if (match) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          customStyle={{
            margin: 0,
            borderRadius: '0.75rem',
            background: 'var(--color-bg-base)',
            border: 'none',
            fontSize: '0.875rem',
          }}
        >
          {code}
        </SyntaxHighlighter>
      );
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ children, ...props }) {
    return (
      <a target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

interface MarkdownContentProps {
  content: string;
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
