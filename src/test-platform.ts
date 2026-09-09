export const WINDOWS_POSIX_SKIP_REASON = "Windows POSIX path/bash assumption; runs on Linux CI";

export function skipOnWindows(t: { skip: (reason: string) => void }): boolean {
  if (process.platform !== "win32") return false;
  t.skip(WINDOWS_POSIX_SKIP_REASON);
  return true;
}
