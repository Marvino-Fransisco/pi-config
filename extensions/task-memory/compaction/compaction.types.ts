export interface CompactionSettings {
  compaction?: {
    keepRecentTokens?: number;
  };
}

export interface EntryDetails {
  source?: string;
  hash?: string;
}

export interface ToolResultMessage {
  role?: string;
  toolName?: string;
  details?: EntryDetails;
}

export interface HashEntry {
  type?: string;
  customType?: string;
  details?: EntryDetails;
  message?: ToolResultMessage;
}
