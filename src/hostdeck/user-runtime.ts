import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseToolArguments } from './contracts.js';
import { RuntimeError } from './runtime-error.js';
import { UserProcesses } from './user-processes.js';

export interface UserRuntimeOptions {
  deviceId: string;
  workspace: string;
  /** Trusted facade hook, never a caller-supplied approval. Missing/failed admission denies. */
  authorize: (operation: string, args: Readonly<Record<string, unknown>>) => Promise<boolean>;
  environment: Readonly<Record<string, string>>;
  shells: Readonly<Partial<Record<'powershell' | 'cmd' | 'wsl', string>>>;
}

const maxFileBytes = 10 * 1024 * 1024;
const fileOperations = new Set(['hostdeck_read_file', 'hostdeck_write_file', 'hostdeck_edit_text', 'hostdeck_file_info']);

/** Internal adapter only. Must be launched under the authorized user token, never service authority. */
export class UserRuntime {
  private closed = false;
  private fileQueue: Promise<unknown> = Promise.resolve();
  private readonly processes: UserProcesses;
  private pending = 0;

  private constructor(private readonly options: UserRuntimeOptions, private readonly workspace: string) {
    this.processes = new UserProcesses(options.environment, options.shells);
  }

  static async create(options: UserRuntimeOptions): Promise<UserRuntime> {
    const workspace = await fs.realpath(options.workspace);
    if (!(await fs.stat(workspace)).isDirectory()) throw new RuntimeError('PATH_DENIED');
    return new UserRuntime({ ...options, environment: { ...options.environment }, shells: { ...options.shells } }, workspace);
  }

  get implementedTools(): ReadonlySet<string> {
    return new Set([...fileOperations, 'hostdeck_start_process', 'hostdeck_read_process', 'hostdeck_interact_process']);
  }

  async invoke(name: string, raw: unknown): Promise<Record<string, unknown>> {
    if (this.closed) throw new RuntimeError('DENIED');
    if (this.pending >= 32) throw new RuntimeError('LIMIT_EXCEEDED');
    this.pending++;
    try { return await this.dispatch(name, raw); }
    finally { this.pending--; }
  }

  private async dispatch(name: string, raw: unknown): Promise<Record<string, unknown>> {
    const args = parseToolArguments(name, raw);
    if (!this.implementedTools.has(name)) throw new RuntimeError('UNAVAILABLE');
    await this.admit(name, args);
    if (!fileOperations.has(name)) {
      try {
        if (name === 'hostdeck_start_process') {
          const workingDirectory = await this.checkedPath((args.working_directory as string | undefined) ?? this.workspace);
          if (!(await fs.stat(workingDirectory)).isDirectory()) throw new RuntimeError('PATH_DENIED');
          await this.admit(name, args);
          return await this.processes.start(args, workingDirectory);
        }
        await this.admit(name, args);
        return await (name === 'hostdeck_read_process' ? this.processes.read(args) : this.processes.interact(args));
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError('IO_ERROR');
      }
    }
    const result = this.fileQueue.then(() => this.fileOperation(name, args));
    this.fileQueue = result.catch(() => {});
    try { return await result; }
    catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('IO_ERROR');
    }
  }

  private async admit(name: string, args: Record<string, unknown>): Promise<void> {
    if (this.closed || args.device_id !== this.options.deviceId) throw new RuntimeError('DENIED');
    let admitted = false;
    try { admitted = await this.options.authorize(name, args) === true; } catch { /* fail closed */ }
    if (!admitted || this.closed) throw new RuntimeError('DENIED');
  }

  /** Hygiene for cooperative user work, not race-safe isolation against another process with this token. */
  private async checkedPath(value: string): Promise<string> {
    const target = path.resolve(this.workspace, value);
    const relative = path.relative(this.workspace, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || relative.includes(':') || /[\x00-\x1f]/.test(value) || value.startsWith('\\\\')) {
      throw new RuntimeError('PATH_DENIED');
    }
    let current = this.workspace;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new RuntimeError('PATH_DENIED');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }

  private async bytes(target: string): Promise<Buffer> {
    const file = await fs.open(target, 'r');
    try {
      if (!(await file.stat()).isFile()) throw new RuntimeError('NOT_FILE');
      // A fixed-size read remains bounded even if another process grows the file after stat.
      const buffer = Buffer.alloc(maxFileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > maxFileBytes) throw new RuntimeError('LIMIT_EXCEEDED');
      return buffer.subarray(0, length);
    } finally { await file.close(); }
  }

  private decode(buffer: Buffer): string {
    if (buffer.includes(0)) throw new RuntimeError('NOT_TEXT');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new RuntimeError('NOT_TEXT'); }
  }

  private async replace(name: string, args: Record<string, unknown>, target: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > maxFileBytes) throw new RuntimeError('LIMIT_EXCEEDED');
    await this.admit(name, args);
    await this.checkedPath(args.path as string);
    const temporary = path.join(path.dirname(target), `.hostdeck-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await this.admit(name, args);
      await this.checkedPath(args.path as string);
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  private async fileOperation(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.admit(name, args);
    const target = await this.checkedPath(args.path as string);
    if (name === 'hostdeck_file_info') {
      const info = await fs.stat(target);
      return { size: info.size, type: info.isDirectory() ? 'directory' : 'file', modified_at: info.mtime.toISOString(),
        ...(args.hash === 'sha256' ? { sha256: createHash('sha256').update(await this.bytes(target)).digest('hex') } : {}) };
    }
    if (name === 'hostdeck_write_file') {
      let original = '';
      if (args.mode === 'append') {
        try { original = this.decode(await this.bytes(target)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await this.replace(name, args, target, original + (args.content as string));
      return { written: true };
    }
    const content = this.decode(await this.bytes(target));
    if (name === 'hostdeck_edit_text') {
      const pieces = content.split(args.old_text as string);
      if (pieces.length - 1 !== args.expected_replacements) throw new RuntimeError('EDIT_CONFLICT');
      await this.replace(name, args, target, pieces.join(args.new_text as string));
      return { replacements: pieces.length - 1 };
    }
    const lines = content === '' ? [] : content.split(/\r?\n/);
    if (content.endsWith('\n')) lines.pop();
    const offset = Math.min(lines.length, Math.max(0, (args.offset as number) < 0 ? lines.length + (args.offset as number) : args.offset as number));
    const selected = lines.slice(offset, offset + (args.length as number));
    return { content: selected.join('\n'), total_lines: lines.length, offset, next_offset: offset + selected.length };
  }

  async dispose(): Promise<void> { this.closed = true; await this.fileQueue; await this.processes.dispose(); }
}
