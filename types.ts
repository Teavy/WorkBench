export interface CameraState {
  azimuth: number; // -180 to 180 degrees
  elevation: number; // -90 to 90 degrees
  distance: number; // 0.5 to 2.0 (relative zoom)
}

export type ContentCategory = 'character' | 'object' | 'building' | 'interior';
export type ControlMode = 'manual' | 'auto';

export interface HistoryItem {
  id: string;
  url: string;
  timestamp: number;
}

export enum AppStatus {
  IDLE = 'IDLE',
  UPLOADING = 'UPLOADING',
  QUEUED = 'QUEUED',
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR'
}
