export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
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
