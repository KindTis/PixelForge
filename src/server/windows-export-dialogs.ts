import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const interactiveGuard = `
if (-not [Environment]::UserInteractive) {
  [Console]::Error.Write('PIXELFORGE_NONINTERACTIVE')
  exit 2
}`;

export type ExportDialogs = {
  selectFolder(signal: AbortSignal): Promise<string | undefined>;
  confirmReplace(outputPath: string, signal: AbortSignal): Promise<boolean>;
};

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) return String(error.stderr);
  return error instanceof Error ? error.message : String(error);
}

async function runPowerShell(script: string, signal: AbortSignal, label: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows 대화상자를 지원하지 않는 환경입니다.");
  try {
    const command = Buffer.from(`${interactiveGuard}\n${script}`, "utf16le").toString("base64");
    const { stdout } = await execute("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
      command,
    ], { encoding: "utf8", signal, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    if (signal.aborted) throw error;
    const message = errorText(error);
    if (message.includes("PIXELFORGE_NONINTERACTIVE")) {
      throw new Error("상호작용 가능한 Windows 데스크톱 세션이 필요합니다.");
    }
    throw new Error(`Windows ${label}을 열 수 없습니다: ${message}`);
  }
}

export const windowsExportDialogs: ExportDialogs = {
  async selectFolder(signal) {
    const output = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'PixelForge 내보내기 폴더 선택'
$dialog.ShowNewFolderButton = $true
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))
  }
} finally {
  $dialog.Dispose()
}`, signal, "폴더 선택창");
    return output ? Buffer.from(output, "base64").toString("utf8") : undefined;
  },

  async confirmReplace(outputPath, signal) {
    const encodedPath = Buffer.from(outputPath, "utf8").toString("base64");
    const output = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$message = "$path\`n\`n이 폴더의 모든 내용을 교체합니다. 계속하시겠습니까?"
$answer = [System.Windows.Forms.MessageBox]::Show(
  $message,
  'PixelForge 내보내기',
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Warning,
  [System.Windows.Forms.MessageBoxDefaultButton]::Button2
)
if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { 'YES' } else { 'NO' }
`, signal, "교체 확인창");
    return output === "YES";
  },
};
