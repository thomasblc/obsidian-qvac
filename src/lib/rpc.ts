// Types for the companion RPC protocol. The daemon is a trusted local process (loopback + per-boot
// token); we cast its parsed-JSON frames/data to these known shapes at the WebSocket boundary so the
// rest of the plugin stays fully typed.

export interface Frame {
  type?: string;
  [key: string]: unknown;
}

export interface RpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  frames: Frame[];
}

// ---- shared entity shapes ----
export interface Hit {
  source: string;
  score?: number;
  content?: string;
  sourceType?: string;
}
export interface Adapter {
  file: string;
  baseKey: string;
  sizeMB: number;
}
export interface Candidate {
  a: string;
  b: string;
  reason: string;
}
export interface ChatMessage {
  role: string;
  content: string;
}
export interface ManifestEntry {
  mtime: number;
  sourceType?: string;
}

// ---- final `data` payloads, per rpc ----
export interface Health {
  version: string;
}
export interface ChatData {
  contentText?: string;
  hits?: Hit[];
  model?: string;
}
export interface CompleteData {
  contentText?: string;
}
export interface HitsData {
  hits?: Hit[];
}
export interface ScanData {
  candidates?: Candidate[];
  notes?: number;
}
export interface TrainData {
  status?: string;
  adapterMB?: number;
  elapsedSec?: number;
}
export interface AdaptersData {
  adapters?: Adapter[];
}
export interface ManifestData {
  manifest?: Record<string, ManifestEntry>;
}
export interface ModelFile {
  name: string;
  path: string;
  sizeMB: number;
}
export interface ModelsData {
  dir: string;
  models: ModelFile[];
  error?: string;
}
export interface CheckData {
  ok: boolean;
  kind?: string;
  sizeMB?: number;
  error?: string;
}

// ---- streaming frame payloads, per rpc ----
export interface ChatFrame extends Frame {
  hits?: Hit[];
  text?: string;
  error?: string;
}
export interface ProvisionFrame extends Frame {
  model?: string;
  percentage?: number;
}
export interface CompleteFrame extends Frame {
  text?: string;
}
export interface ScanFrame extends Frame {
  done?: number;
  total?: number;
}
export interface TrainFrame extends Frame {
  proseNotes?: number;
  epoch?: number;
  step?: number;
  totalBatches?: number;
  loss?: number;
  etaSec?: number;
}
