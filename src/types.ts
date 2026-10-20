export interface Env {
  FIREBASE_PROJECT_ID: string;
  ENVIRONMENT: string;
  CRUN_BASE_URL: string;
  CRUN_TIMEOUT_MS: string;
  CRUN_POLL_INTERVAL_MS: string;
  CRUN_MAX_POLL_ATTEMPTS: string;
  R2_PUBLIC_BASE_URL: string;
  ALLOWED_ORIGIN: string;
  ADMOB_SSV_ENABLED: string;
  GOOGLE_PLAY_BILLING_ENABLED: string;
  MAX_UPLOAD_SIZE_MB: string;
  ALLOWED_MIME_TYPES: string;
  CRUN_API_KEY: string;
  CRUN_WEBHOOK_SECRET?: string;
  WORKER_BASE_URL?: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  R2_BUCKET: R2Bucket;
  KV_CACHE: KVNamespace;
  CRUN_TEMPLATE_QUEUE: Queue<CrunTemplateSyncMessage>;
}

export interface CrunTemplateSyncMessage {
  provider: "kling" | "bytedance" | "vidu";
  page: number;
}

export interface DecodedIdToken {
  uid: string;
  email?: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  sub: string;
  firebase?: { sign_in_provider?: string; identities?: Record<string, unknown> };
}

export interface AuthContext {
  uid: string;
  email?: string;
  token: DecodedIdToken;
}

export interface UserCredits {
  credits: number;
  updated_at: number;
}

export interface LedgerEntry {
  id: string;
  user_id: string;
  type: "debit" | "credit";
  amount: number;
  reason: string;
  balance_after: number;
  pricing_version?: string;
  job_id?: string;
  transaction_id?: string;
  created_at: number;
}

export interface TemplateDoc {
  id: string;
  name: string;
  description: string;
  model_id?: string;
  crun_provider?: "kling" | "bytedance" | "vidu";
  crun_template_id?: string;
  is_active: boolean;
  category?: string;
  preview_video_url: string;
  thumbnail_url?: string;
  reference_video_url?: string;
  base_cost: number;
  provider_cost?: number;
  customization_config?: {
    allow_image_input?: boolean;
    allow_prompt?: boolean;
    allow_reference_video?: boolean;
  };
  aspect_ratio_options?: string[];
  duration_options?: (string | number)[];
  resolution_options?: string[];
  option_pricing?: Record<string, Record<string, number>>;
  supported_options: TemplateOption[];
  created_at: number;
  updated_at: number;
}

export interface TemplateOption {
  key: string;
  label: string;
  type: "select" | "number" | "boolean" | "text";
  required: boolean;
  allowed_values?: (string | number)[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
}

export type JobStatus =
  | "pending" | "quoted" | "debited" | "submitted" | "processing"
  | "succeeded" | "failed" | "refunded" | "timeout_reconciling";

export interface JobDoc {
  id: string;
  user_id: string;
  template_id: string;
  model_id: string;
  crun_model_id?: string;
  status: JobStatus;
  options: Record<string, unknown>;
  input_asset_keys: string[];
  output_asset_key?: string;
  output_url?: string;
  crun_job_id?: string;
  crun_response?: Record<string, unknown>;
  price: number;
  pricing_version: string;
  balance_after: number;
  error?: string;
  created_at: number;
  updated_at: number;
  completed_at?: number;
}

export interface AdRewardEvent {
  id: string;
  user_id: string;
  transaction_id: string;
  reward_amount: number;
  ad_unit_id?: string;
  verified: boolean;
  created_at: number;
}

export interface PurchaseDoc {
  id: string;
  uid: string;
  product_id: string;
  purchase_token: string;
  order_id: string;
  credits_granted: number;
  status: "verified" | "consumed" | "cancelled" | "refunded";
  verified_at: number;
  created_at: number;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface QuoteRequest {
  template_id: string;
  options: Record<string, unknown>;
}

export interface QuoteResponse {
  price: number;
  breakdown: { base: number; options: Record<string, number> };
  pricing_version: string;
}

export interface GenerationRequest {
  template_id: string;
  options: Record<string, unknown>;
  input_asset_keys: string[];
  idempotency_key?: string;
}

export interface GenerationResponse {
  job_id: string;
  status: JobStatus;
  price: number;
  pricing_version: string;
}

export interface UploadResponse {
  key: string;
  upload_url: string;
  expires_at: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description: string;
  capabilities: string[];
  max_duration_seconds?: number;
  supported_aspect_ratios?: string[];
  supports_reference_video: boolean;
  supports_image_input: boolean;
}

export interface CrunCreateJobInput {
  model_id: string;
  prompt?: string;
  image_asset_keys?: string[];
  reference_video_url?: string;
  options: Record<string, unknown>;
  webhook_url?: string;
}

export interface CrunCreateJobResult {
  crun_job_id: string;
  status: "submitted" | "processing" | "succeeded" | "failed";
  result_url?: string;
  raw: Record<string, unknown>;
}

export interface CrunJobStatus {
  crun_job_id: string;
  status: "processing" | "succeeded" | "failed";
  result_url?: string;
  error?: string;
  raw: Record<string, unknown>;
}

export interface CrunModelAdapter {
  model_id: string;
  createJob(input: CrunCreateJobInput, env: Env): Promise<CrunCreateJobResult>;
  getJobStatus(crun_job_id: string, env: Env): Promise<CrunJobStatus>;
}
