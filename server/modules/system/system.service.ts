type SystemUpdateCommandResult = {
  exitCode: number | null;
  output: string;
  errorOutput: string;
};

// Local fork patch: `origin` is the personal fork, so git installs merge the
// upstream release line instead of pulling the fork. A conflicting merge is
// aborted so the working tree is never left half-merged.
const GIT_UPDATE_COMMAND =
  'git fetch upstream && git checkout main && '
  + '{ git merge --no-edit upstream/main || { git merge --abort; exit 1; }; } && npm install';

type SystemUpdateDependencies = {
  appRoot: string;
  homeDirectory: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  environment: NodeJS.ProcessEnv;
  runShellCommand(
    command: string,
    workingDirectory: string,
    environment: NodeJS.ProcessEnv,
    onOutput: (output: string) => void,
    onErrorOutput: (errorOutput: string) => void,
  ): Promise<SystemUpdateCommandResult>;
  logInfo(message: string, detail?: string): void;
  logError(message: string, detail?: string): void;
};

/**
 * Creates the update workflow used by the system module and its focused tests.
 * Runtime-specific process spawning stays behind the injected command adapter.
 */
export function createSystemUpdateService(dependencies: SystemUpdateDependencies) {
  return {
    /** Selects and executes the correct update workflow for this installation. */
    async updateSystem() {
      const updateCommand = dependencies.isPlatform
        ? 'npm run update:platform'
        : dependencies.installMode === 'git'
          ? GIT_UPDATE_COMMAND
          : 'npm install -g @cloudcli-ai/cloudcli@latest';
      const workingDirectory = dependencies.isPlatform || dependencies.installMode === 'git'
        ? dependencies.appRoot
        : dependencies.homeDirectory;

      dependencies.logInfo('Starting system update from directory:', workingDirectory);

      try {
        const result = await dependencies.runShellCommand(
          updateCommand,
          workingDirectory,
          dependencies.environment,
          (output) => dependencies.logInfo('Update output:', output),
          (errorOutput) => dependencies.logError('Update error:', errorOutput),
        );

        if (result.exitCode === 0) {
          return {
            success: true as const,
            output: result.output || 'Update completed successfully',
            message: 'Update completed. Please restart the server to apply changes.',
          };
        }

        return {
          success: false as const,
          error: 'Update command failed',
          output: result.output,
          errorOutput: result.errorOutput,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logError('Update process error:', message);
        return {
          success: false as const,
          error: message,
        };
      }
    },
  };
}
