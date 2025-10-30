export interface AuthUser {
  id: string;
  identity?: string;
  email?: string;
}

export interface AuthContext {
  user: AuthUser;
  scopes: string[];
}