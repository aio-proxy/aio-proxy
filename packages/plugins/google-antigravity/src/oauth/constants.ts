declare const __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__: string;
declare const __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__: string;

export const GOOGLE_CLIENT_ID = __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__;
export const GOOGLE_CLIENT_SECRET = __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__;
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
export const ANTIGRAVITY_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_PROD = "https://cloudcode-pa.googleapis.com";
export const GOOGLE_ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;
