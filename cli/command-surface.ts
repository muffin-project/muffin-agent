/**
 * The command vocabulary is product data: dispatch accepts these names, help
 * projects the owner-facing subset, and shell completion projects the complete
 * supported surface.  Do not keep a second handwritten list in any of them.
 */
export type CommandAudience = 'owner' | 'operator' | 'recovery' | 'inspection';

export type CommandSpec = {
  name: string;
  summary: string;
  audience: CommandAudience;
  primary?: boolean;
  aliases?: readonly string[];
  subcommands?: readonly string[];
};

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'init', summary: 'configura Muffin; su terminale chiede la chiave nascosta', audience: 'owner', primary: true },
  { name: 'model', summary: 'mostra o cambia modello e corsia', audience: 'owner', primary: true },
  { name: 'surface', summary: 'collega e gestisce Telegram e le altre superfici', audience: 'owner', primary: true, subcommands: ['list', 'enable', 'disable', 'default'] },
  { name: 'search', summary: 'configura o disattiva la ricerca web', audience: 'owner', primary: true },
  { name: 'run', summary: 'esegue un obiettivo senza aprire il terminale interattivo', audience: 'owner', primary: true },
  { name: 'update', summary: 'aggiorna Muffin oppure torna alla release precedente', audience: 'owner', primary: true },
  { name: 'doctor', summary: 'diagnostica dettagliata quando qualcosa non torna', audience: 'owner', primary: true },
  { name: 'help', summary: 'mostra questa guida; --all espone il control plane', audience: 'owner', primary: true },
  { name: 'repl', summary: 'alias esplicito della conversazione nel terminale', audience: 'operator' },
  { name: 'config', summary: 'ispezione e regolazioni tecniche', audience: 'operator', subcommands: ['set'] },
  { name: 'adopt', summary: 'adotta defaults spediti rimasti indietro', audience: 'recovery' },
  { name: 'backup', summary: 'backup online del database', audience: 'recovery' },
  { name: 'restore', summary: 'ripristino esplicito da backup', audience: 'recovery' },
  { name: 'rot', summary: 'Root of Trust: verifica, reseal, hardening', audience: 'recovery', subcommands: ['verify', 'reseal', 'harden'] },
  { name: 'uninstall', summary: 'rimuove la Home dopo conferma', audience: 'recovery' },
  { name: 'memory', summary: 'ispezione e manutenzione della memoria', audience: 'inspection', aliases: ['memoria'], subcommands: ['why', 'search', 'extract', 'stats', 'check', 'review', 'pin', 'unpin'] },
  { name: 'vault', summary: 'ispezione e indicizzazione del vault', audience: 'inspection', subcommands: ['reindex', 'add', 'ls', 'check'] },
  { name: 'mcp', summary: 'gestione operator di server MCP', audience: 'operator', subcommands: ['list', 'add', 'remove'] },
  { name: 'jobs', summary: 'gestione operator dei job', audience: 'operator', aliases: ['lavori'], subcommands: ['list', 'add', 'remove', 'cap'] },
  { name: 'gateway', summary: 'supervisore e lifecycle del processo', audience: 'operator', subcommands: ['status', 'stop', 'start', 'restart', 'install', 'run'] },
  { name: 'observe', summary: 'ispezione della proattività', audience: 'inspection' },
  { name: 'prompt', summary: 'ispezione del prompt effettivo', audience: 'inspection', subcommands: ['show', 'version'] },
  { name: 'secret', summary: 'ingresso headless di segreti', audience: 'operator', aliases: ['segreto'], subcommands: ['set'] },
  { name: 'trace', summary: 'tracce e diagnostica dei turni', audience: 'inspection', subcommands: ['tail', 'grep', 'turn'] },
  { name: 'undo', summary: 'annulla gli effetti reversibili di un turno', audience: 'recovery', aliases: ['annulla'] },
  { name: 'orientamento', summary: 'metrica di orientamento su un database esplicito', audience: 'inspection' },
  { name: 'effects', summary: 'registro tecnico degli effetti', audience: 'inspection' },
  { name: 'completion', summary: 'genera completion per bash, zsh o fish', audience: 'operator' },
] as const;

export function canonicalCommand(input: string): string {
  return COMMANDS.find((command) => command.name === input || command.aliases?.includes(input))?.name ?? input;
}

export function primaryHelp(): string {
  const rows = COMMANDS.filter((command) => command.primary).map((command) => `  muffin ${command.name.padEnd(8)} ${command.summary}`);
  return [
    'muffin — il tuo agente personale',
    '',
    '  muffin          apri la conversazione. Da qui puoi chiedere il lavoro normale.',
    ...rows,
    '',
    'Per diagnosi, recovery e automazioni: muffin help --all',
    'Nel REPL: /help; Tab completa i controlli disponibili.',
  ].join('\n') + '\n';
}

export function allHelp(): string {
  const groups: readonly CommandAudience[] = ['owner', 'recovery', 'operator', 'inspection'];
  const headings: Record<CommandAudience, string> = {
    owner: 'gesti owner:', recovery: 'recovery esplicito:', operator: 'operator:', inspection: 'ispezione:',
  };
  return groups.flatMap((audience) => {
    const rows = COMMANDS.filter((command) => command.audience === audience).map((command) =>
      `  muffin ${command.name.padEnd(13)} ${command.summary}`,
    );
    return rows.length === 0 ? [] : ['', headings[audience], ...rows];
  }).join('\n') + '\n';
}

function candidates(): string {
  return COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]).join(' ');
}

function subcommandCases(bashVariable: string): string {
  return COMMANDS.filter((command) => command.subcommands?.length)
    .map((command) => `    ${command.name}) COMPREPLY=( $(compgen -W '${command.subcommands?.join(' ')}' -- \"${bashVariable}\") ); return ;;`)
    .join('\n');
}

export function completion(shell: string): string | null {
  const words = candidates();
  if (shell === 'bash') return `# bash completion for muffin\n_muffin() {\n  if (( COMP_CWORD == 1 )); then\n    COMPREPLY=( $(compgen -W '${words}' -- "${'$'}{COMP_WORDS[1]}") )\n    return\n  fi\n  case "${'$'}{COMP_WORDS[1]}" in\n${subcommandCases('${COMP_WORDS[COMP_CWORD]}')}\n  esac\n}\ncomplete -F _muffin muffin\n`;
  if (shell === 'zsh') {
    const subcommands = COMMANDS.filter((command) => command.subcommands?.length)
      .map((command) => `    ${command.name}) _values 'subcommand' ${command.subcommands?.join(' ')} ;;`).join('\n');
    return `#compdef muffin\n_muffin() {\n  if (( CURRENT == 2 )); then\n    _values 'command' ${words}\n    return\n  fi\n  case "${'$'}words[2]" in\n${subcommands}\n  esac\n}\n_muffin "$@"\n`;
  }
  if (shell === 'fish') {
    const top = words.split(' ').map((word) => `complete -c muffin -f -a ${word}`);
    const sub = COMMANDS.filter((command) => command.subcommands?.length)
      .flatMap((command) => command.subcommands!.map((subcommand) => `complete -c muffin -n '__fish_seen_subcommand_from ${command.name}' -a ${subcommand}`));
    return [...top, ...sub].join('\n') + '\n';
  }
  return null;
}
