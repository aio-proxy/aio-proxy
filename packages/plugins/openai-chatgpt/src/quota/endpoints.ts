const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api' as const;

export const USAGE_URL = `${CHATGPT_BACKEND_BASE_URL}/wham/usage` as const;
export const RESET_CREDITS_URL = `${CHATGPT_BACKEND_BASE_URL}/wham/rate-limit-reset-credits` as const;
export const RESET_CREDITS_CONSUME_URL = `${RESET_CREDITS_URL}/consume` as const;
