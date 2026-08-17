export interface NavigationState {
  currentUrl: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  notice: string | null;
}

export interface ShellState extends NavigationState {
  homeUrl: string;
  phase: 'starting' | 'ready' | 'error';
}
