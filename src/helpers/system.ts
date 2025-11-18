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

export function formatDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0'); // 月份从0开始，所以需要+1
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}


