export type ProviderKind = "server-poll" | "device-push";
export type ControlAction = "next" | "prev" | "playpause";
export interface NowPlaying {
  trackId: string; title: string; artist: string; album: string;
  artUrl?: string; durationMs: number; progressMs: number;
  isPlaying: boolean; startedAt: number; dominantColor?: string;
}
export interface MusicProvider {
  id: string;
  kind: ProviderKind;
  getNowPlaying?(accessToken: string): Promise<NowPlaying | null>;
  control?(accessToken: string, action: ControlAction): Promise<void>;
}
