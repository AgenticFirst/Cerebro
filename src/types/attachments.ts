export interface AttachmentInfo {
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  extension: string;
  /** Known after a stat — undefined means "unknown yet / need to stat". */
  isDirectory?: boolean;
}
