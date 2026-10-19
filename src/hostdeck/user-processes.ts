import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { RuntimeError } from './runtime-error.js';

type Shell = 'powershell' | 'cmd' | 'wsl';
interface ProcessRecord {
  child: ChildProcessWithoutNullStreams;
  output: string;
  outputBytes: number;
  truncated: boolean;
  closed: boolean;
  failed: boolean;
  inputPending: boolean;
  exitCode: number | null;
  waiters: Set<() => void>;
}
const maxOutputBytes = 1024 * 1024;

/** Pipe-based children only; native process-tree containment/cancellation is separate work. */
export class UserProcesses {
  private readonly records = new Map<string, ProcessRecord>();

  constructor(private readonly environment: Readonly<Record<string, string>>,
    private readonly shells: Readonly<Partial<Record<Shell, string>>>) {}

  private async observe(record: ProcessRecord, timeout: number): Promise<void> {
    if (record.closed) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); record.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, timeout);
      record.waiters.add(finish);
    });
  }

  private snapshot(id: string, record: ProcessRecord, offset = 0, limit = 1000) {
    const lines = record.output === '' ? [] : record.output.split(/\r?\n/);
    if (record.output.endsWith('\n')) lines.pop();
    const start = Math.min(lines.length, Math.max(0, offset < 0 ? lines.length + offset : offset));
    const selected = lines.slice(start, start + limit);
    const partial = !record.closed && record.output !== '' && !record.output.endsWith('\n')
      && selected.length > 0 && start + selected.length === lines.length;
    return { process_id: id, state: record.failed ? 'failed' : record.closed ? 'exited' : 'running', exit_code: record.exitCode,
      output: selected.join('\n'), total_lines: lines.length, offset: start, next_offset: start + selected.length - (partial ? 1 : 0), partial_line: partial,
      output_truncated: record.truncated, retained: 'prefix', pty: false };
  }

  async start(args: Record<string, unknown>, workingDirectory: string): Promise<Record<string, unknown>> {
    const shell = args.shell as Shell;
    const executable = this.shells[shell];
    // WSL needs a separately bound Linux executor/workspace; Windows paths must never be substituted.
    if (!executable || !path.isAbsolute(executable) || shell === 'wsl') throw new RuntimeError('UNAVAILABLE');
    if (this.records.size >= 32) {
      const old = [...this.records].find(([, record]) => record.closed);
      if (!old) throw new RuntimeError('LIMIT_EXCEEDED');
      this.records.delete(old[0]);
    }
    const command = args.command as string;
    const powershellCommand = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false);\n" + command;
    const shellArgs = shell === 'powershell'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(powershellCommand, 'utf16le').toString('base64')]
      : ['/d', '/s', '/c', command];
    const child = spawn(executable, shellArgs, { cwd: workingDirectory, env: { ...this.environment }, windowsHide: true, shell: false, stdio: 'pipe' });
    const record: ProcessRecord = { child, output: '', outputBytes: 0, truncated: false, closed: false, failed: false, inputPending: false,
      exitCode: null, waiters: new Set() };
    const collect = (chunk: string) => {
      if (record.truncated) return;
      const room = maxOutputBytes - record.outputBytes;
      const buffer = Buffer.from(chunk);
      if (buffer.length > room) record.truncated = true;
      let prefix = buffer.subarray(0, room);
      // Do not retain a partial UTF-8 codepoint at the truncation boundary.
      while (prefix.length && !isUtf8(prefix)) prefix = prefix.subarray(0, prefix.length - 1);
      record.output += prefix.toString('utf8');
      record.outputBytes += prefix.length;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    child.stdin.on('error', () => { /* A closed input is reported by interact; no raw exception logging. */ });
    child.on('error', () => { record.failed = true; });
    child.on('close', code => {
      record.closed = true; record.exitCode = code;
      for (const finish of record.waiters) finish();
    });
    const id = randomUUID();
    this.records.set(id, record);
    await this.observe(record, args.timeout_ms as number);
    return this.snapshot(id, record);
  }

  async read(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = args.process_id as string;
    const record = this.records.get(id);
    if (!record) throw new RuntimeError('UNKNOWN_PROCESS');
    await this.observe(record, args.timeout_ms as number);
    return this.snapshot(id, record, args.offset as number, args.limit as number);
  }

  async interact(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = args.process_id as string;
    const record = this.records.get(id);
    if (!record) throw new RuntimeError('UNKNOWN_PROCESS');
    if (record.closed || record.child.stdin.destroyed) throw new RuntimeError('PROCESS_CLOSED');
    if (record.inputPending) throw new RuntimeError('INPUT_BUSY');
    const deadline = Date.now() + (args.timeout_ms as number);
    record.inputPending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delivery: string;
    try {
      delivery = await Promise.race([
        new Promise<string>(resolve => {
          record.child.stdin.write(args.input as string, error => {
            record.inputPending = false;
            resolve(error ? 'uncertain' : 'written_to_pipe');
          });
        }),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('uncertain'), Math.max(1, deadline - Date.now())); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    // Timed-out input may still arrive later. Keep the outstanding-write fence until its callback.
    if (delivery === 'written_to_pipe') await this.observe(record, Math.max(0, deadline - Date.now()));
    return { ...this.snapshot(id, record), input_delivery: delivery, retry_safe: false };
  }

  async dispose(): Promise<void> {
    const running = [...this.records.values()].filter(record => !record.closed);
    for (const record of running) record.child.kill(); // Direct owned child handle only; no PID-based tree claim.
    await Promise.all(running.map(record => this.observe(record, 2000)));
    if (running.some(record => !record.closed)) throw new RuntimeError('CHILD_STILL_RUNNING');
  }
}
