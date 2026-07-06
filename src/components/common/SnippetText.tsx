// Backend search endpoints wrap matched spans in sentinel control chars
// (U+0001/U+0002 — see knowledge/router.py and conversation_search.py
// SNIP_START/SNIP_END). Defined via fromCharCode so the source stays printable.
const SENT_START = String.fromCharCode(1);
const SENT_END = String.fromCharCode(2);

/** Render a snippet, bolding the sentinel-wrapped matched spans. Text-only —
 *  no HTML parsing, so user content can't inject markup. */
export function SnippetText({ snippet }: { snippet: string }) {
  // Each chunk after the first opens with a highlighted span (…<START>hit<END>rest).
  const parts = snippet.split(SENT_START);
  return (
    <>
      {parts.map((part, idx) => {
        if (idx === 0) return <span key={idx}>{part}</span>;
        const [hit, rest = ''] = part.split(SENT_END);
        return (
          <span key={idx}>
            <mark className="bg-accent/20 text-text-primary rounded-[2px] px-0.5">{hit}</mark>
            {rest}
          </span>
        );
      })}
    </>
  );
}
