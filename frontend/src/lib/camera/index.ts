// Camera contract (orchestrator-owned signatures; wave 2 agent B3 implements).
import type { IncomingPhoto } from '../repo'

/** 'native' = iOS system camera via file input; 'fast' = in-app getUserMedia sheet. */
export type CaptureMode = 'native' | 'fast'

/**
 * Open the system picker and resolve with the chosen files as IncomingPhoto
 * (exact bytes, no re-encoding). 'camera' uses capture="environment" (single
 * shot); 'library' allows multiple selection without capture. MUST be called
 * synchronously from a user gesture handler (iOS requirement). Resolves [] if
 * the user cancels.
 */
export function pickPhotos(kind: 'camera' | 'library'): Promise<IncomingPhoto[]> {
  void kind
  return Promise.reject(new Error('pickPhotos is not implemented yet'))
}
