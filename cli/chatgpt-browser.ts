import { spawn } from 'node:child_process';

/** Launch the account consent page without a shell or printing the URL. */
export async function openChatGPTBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new Error('Unable to open the sign-in browser.')));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Unable to open the sign-in browser.')),
    );
  });
}
