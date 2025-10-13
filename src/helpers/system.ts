import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export const kenmec_file_path =
  os.homedir() + (os.platform() == 'win32' ? '\\kenmec' : '/kenmec');

export const kenmecLogs = path.join(kenmec_file_path, '_logs');
export const FileChecker = () => {
    if (!fs.existsSync(kenmecLogs)) {
        fs.mkdirSync(kenmecLogs, { recursive: true });
      }
}

