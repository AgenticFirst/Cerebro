export interface ParseResult {
  sha256: string;
  parsedPath: string;
  charCount: number;
  parser: string;
  parserVersion: string;
  truncated: boolean;
  warning: string | null;
  cached: boolean;
}

interface ParseResponseBody {
  sha256: string;
  parsed_path: string;
  char_count: number;
  parser: string;
  parser_version: string;
  truncated: boolean;
  warning: string | null;
  cached: boolean;
}

export class ParseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function parseFileViaBackend(absolutePath: string): Promise<ParseResult> {
  const res = await window.cerebro.invoke<ParseResponseBody | { detail?: string }>({
    method: 'POST',
    path: '/files/parse',
    body: { file_path: absolutePath },
  });
  if (!res.ok) {
    const detail =
      res.data && typeof res.data === 'object' && 'detail' in res.data
        ? String((res.data as { detail?: string }).detail ?? '')
        : `HTTP ${res.status}`;
    throw new ParseError(detail || 'parse failed', res.status);
  }
  const body = res.data as ParseResponseBody;
  return {
    sha256: body.sha256,
    parsedPath: body.parsed_path,
    charCount: body.char_count,
    parser: body.parser,
    parserVersion: body.parser_version,
    truncated: body.truncated,
    warning: body.warning,
    cached: body.cached,
  };
}
