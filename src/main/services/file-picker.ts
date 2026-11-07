import { dialog, type BrowserWindow } from 'electron';
import { basename } from 'node:path';

export class FilePicker {
  constructor(
    private window: () => BrowserWindow | null,
    private automation: boolean,
  ) {}
  async chooseSaveFile(source: string): Promise<string | undefined> {
    if (this.automation && process.env.DATA_AGENT_TEST_SAVE_FILE)
      return process.env.DATA_AGENT_TEST_SAVE_FILE;
    const win = this.window();
    if (!win) return;
    const result = await dialog.showSaveDialog(win, {
      title: '另存文件',
      defaultPath: basename(source),
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePath;
  }
  async chooseFiles(): Promise<string[]> {
    // Only the OS-picker result is substituted in automated tests; all business logic remains real.
    if (this.automation && process.env.DATA_AGENT_TEST_PICK_FILES) {
      const files: unknown = JSON.parse(process.env.DATA_AGENT_TEST_PICK_FILES);
      if (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
        throw new Error('Invalid test file-picker fixture');
      return files;
    }
    const win = this.window();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: '选择 CSV 数据文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    return result.canceled ? [] : result.filePaths;
  }
  async chooseDirectory(): Promise<string | undefined> {
    if (this.automation && process.env.DATA_AGENT_TEST_PICK_DIRECTORY)
      return process.env.DATA_AGENT_TEST_PICK_DIRECTORY;
    const win = this.window();
    if (!win) return;
    const result = await dialog.showOpenDialog(win, {
      title: '选择工作区父目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }
}
