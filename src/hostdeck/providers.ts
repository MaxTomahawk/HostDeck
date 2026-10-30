import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RuntimeError} from './runtime-error.js';
import type {FileOwnerContext} from './files.js';

export type SearchProvider = 'direct' | 'everything';
export type SearchCapability = 'files.name' | 'files.content';

/** HostDeck-owned preferences only. SQLite transactions also serialize separate agents. */
export class ProviderRegistry {
  private constructor(private readonly file:string) {}
  static async open(file:string):Promise<ProviderRegistry> {
    if(!path.isAbsolute(file))throw new RuntimeError('PROVIDER_CONFIGURATION_INVALID');
    await fs.mkdir(path.dirname(file),{recursive:true});
    const registry=new ProviderRegistry(file);
    registry.withDatabase(()=>{});
    return registry;
  }
  private withDatabase<T>(action:(db:DatabaseSync)=>T):T {
    const db=new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS preferences(owner TEXT NOT NULL,device TEXT NOT NULL,executor TEXT NOT NULL,capability TEXT NOT NULL,provider TEXT NOT NULL,PRIMARY KEY(owner,device,executor,capability))');
      db.exec('CREATE TABLE IF NOT EXISTS provider_enablement(owner TEXT NOT NULL,device TEXT NOT NULL,executor TEXT NOT NULL,provider TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),PRIMARY KEY(owner,device,executor,provider))');
      return action(db);
    }finally{db.close();}
  }
  private check(context:FileOwnerContext,capability:SearchCapability,provider?:SearchProvider|null) {
    if(!context.ownerId||!context.deviceId||!context.executorId)throw new RuntimeError('PROVIDER_OWNER_REQUIRED');
    if(!['files.name','files.content'].includes(capability))throw new RuntimeError('PROVIDER_CAPABILITY_UNSUPPORTED');
    if(provider!==undefined&&provider!==null&&!['direct','everything'].includes(provider))throw new RuntimeError('PROVIDER_UNKNOWN');
    if(capability==='files.content'&&provider==='everything')throw new RuntimeError('PROVIDER_CAPABILITY_UNSUPPORTED');
  }
  async preference(context:FileOwnerContext,capability:SearchCapability):Promise<SearchProvider|null> {
    this.check(context,capability);
    return this.withDatabase(db=>{
      const row=db.prepare('SELECT provider FROM preferences WHERE owner=? AND device=? AND executor=? AND capability=?').get(context.ownerId,context.deviceId,context.executorId,capability);
      if(!row)return null;
      const provider=row.provider as SearchProvider;
      this.check(context,capability,provider);return provider;
    });
  }
  async select(context:FileOwnerContext,capability:SearchCapability,override?:SearchProvider):Promise<SearchProvider> {
    this.check(context,capability,override);
    return override??await this.preference(context,capability)??'direct';
  }
  async set(context:FileOwnerContext,capability:SearchCapability,provider:SearchProvider|null):Promise<void> {
    this.check(context,capability,provider);
    this.withDatabase(db=>{
      const keys=[context.ownerId,context.deviceId,context.executorId,capability];
      if(provider===null)db.prepare('DELETE FROM preferences WHERE owner=? AND device=? AND executor=? AND capability=?').run(...keys);
      else db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?) ON CONFLICT(owner,device,executor,capability) DO UPDATE SET provider=excluded.provider').run(...keys,provider);
    });
  }
  async enabledOverride(context:FileOwnerContext,provider:SearchProvider):Promise<boolean|null> {
    this.check(context,'files.name',provider);
    if(provider==='direct')return null;
    return this.withDatabase(db=>{
      const row=db.prepare('SELECT enabled FROM provider_enablement WHERE owner=? AND device=? AND executor=? AND provider=?').get(context.ownerId,context.deviceId,context.executorId,provider);
      return row?row.enabled===1:null;
    });
  }
  async enabled(context:FileOwnerContext,provider:SearchProvider):Promise<boolean> {
    return await this.enabledOverride(context,provider)??true;
  }
  async setEnabled(context:FileOwnerContext,provider:SearchProvider,enabled:boolean|null):Promise<void> {
    this.check(context,'files.name',provider);
    if(provider==='direct')throw new RuntimeError('PROVIDER_IMMUTABLE');
    if(enabled!==null&&typeof enabled!=='boolean')throw new RuntimeError('PROVIDER_CONFIGURATION_INVALID');
    this.withDatabase(db=>{
      const keys=[context.ownerId,context.deviceId,context.executorId,provider];
      if(enabled===null)db.prepare('DELETE FROM provider_enablement WHERE owner=? AND device=? AND executor=? AND provider=?').run(...keys);
      else db.prepare('INSERT INTO provider_enablement VALUES(?,?,?,?,?) ON CONFLICT(owner,device,executor,provider) DO UPDATE SET enabled=excluded.enabled').run(...keys,Number(enabled));
    });
  }
}
