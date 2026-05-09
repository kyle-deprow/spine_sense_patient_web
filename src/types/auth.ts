export interface BackendTokenPair {
  access_token: string
  refresh_token: string
  token_type?: string
}

export interface LoginResponse extends Partial<BackendTokenPair> {
  mfa_required?: boolean
  mfa_token?: string | null
  user_id?: string | null
  mfa_method_id?: string | null
}

export interface RegisterResponse {
  id?: string
  user_id?: string
  email?: string
  phone?: string | null
  user_type?: string
  is_active?: boolean
  email_verified?: boolean
  phone_verified?: boolean
  mfa_enabled?: boolean
  message?: string
  access_token?: string
  refresh_token?: string
}

export interface SessionResponse {
  user_id: string
  user_type: string
  exp: string
  is_active: boolean
  verification_status: string
  has_completed_onboarding: boolean
}
