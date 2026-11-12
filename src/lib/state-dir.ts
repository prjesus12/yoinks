import os from 'node:os'
import path from 'node:path'

/**
 * Where yoinks keeps its own files — settings, cookies, history.
 * `YOINKS_STATE_DIR` points it elsewhere so the state can live somewhere
 * writable (a service's StateDirectory) and so tests stay out of the real
 * home directory.
 */
export const stateDir = () => process.env.YOINKS_STATE_DIR || path.join(os.homedir(), '.config', 'yoinks')
