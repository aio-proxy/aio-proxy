// Static shell-completion scripts for the top-level `aio-proxy` commands.
// Static (rather than reflected from commander) keeps output deterministic and
// decoupled from internal command wiring.
const COMMANDS = 'run reload status config dashboard provider plugin service doctor completion';

const bash = `# aio-proxy bash completion
# Install: aio-proxy completion bash > /etc/bash_completion.d/aio-proxy
_aio_proxy() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS}" -- "$cur") )
  fi
}
complete -F _aio_proxy aio-proxy
`;

const zsh = `# aio-proxy zsh completion
# Install: aio-proxy completion zsh > "\${fpath[1]}/_aio-proxy"
#compdef aio-proxy
_aio_proxy() {
  local -a commands
  commands=(${COMMANDS})
  _describe 'command' commands
}
_aio_proxy "$@"
`;

const fish = `# aio-proxy fish completion
# Install: aio-proxy completion fish > ~/.config/fish/completions/aio-proxy.fish
${COMMANDS.split(' ')
  .map((cmd) => `complete -c aio-proxy -n __fish_use_subcommand -a ${cmd}`)
  .join('\n')}
`;

const SCRIPTS = { bash, zsh, fish };

export type Shell = keyof typeof SCRIPTS;

export function isSupportedShell(shell: string): shell is Shell {
  return shell in SCRIPTS;
}

export const SUPPORTED_SHELLS = Object.keys(SCRIPTS);

export function renderCompletion(shell: Shell): string {
  return SCRIPTS[shell];
}
