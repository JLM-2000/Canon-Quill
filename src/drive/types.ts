export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  /** Bytes, as reported by Drive. Absent for native Google Docs formats. */
  size?: number;
}

/** A node in a recursively walked Drive folder. */
export interface DriveTreeNode extends DriveFileSummary {
  /** Slash-joined path from the walk root, for display and grouping. */
  path: string;
  isFolder: boolean;
  children?: DriveTreeNode[];
}

export interface WriteTextFileInput {
  folderId: string;
  name: string;
  content: string;
  mimeType?: string;
  overwrite?: boolean;
}

export interface UploadBinaryFileInput {
  folderId: string;
  name: string;
  base64Content: string;
  mimeType: string;
  overwrite?: boolean;
}
