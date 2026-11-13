import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {RuntimeError} from './runtime-error.js';
import type {FileOwnerContext} from './files.js';

export type SearchProvider = 'direct' | 'everything';
export type SearchCapability = 'files.name' | 'files.content';
export interface ProviderChange {
  id:string;kind:'preference'|'enablement';target:SearchCapability|'everything';
  before:SearchProvider|boolean|null;after:SearchProvider|boolean|null;
  revision:number;changed:boolean;createdAt:string;
}
interface ProviderSettings {
  preferences:{capability:SearchCapability;provider:SearchProvider|null;revision:number}[];
  everything:{enabledOverride:boolean|null;revision:number};changes:ProviderChange[];
}

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
      db.exec('CREATE TABLE IF NOT EXISTS provider_versions(owner TEXT NOT NULL,device TEXT NOT NULL,executor TEXT NOT NULL,target TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(owner,device,executor,target)); CREATE TABLE IF NOT EXISTS provider_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,device TEXT NOT NULL,executor TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS provider_changes_owner ON provider_changes(owner,device,executor,sequence)');
      // Old supported releases still write these same tables. Database triggers
      // invalidate revisions even through those writers, including an ABA.
      for(const [table,column,target] of [['preferences','provider',"'preference:'||{row}.capability"],['provider_enablement','enabled',"'enablement:'||{row}.provider"]]){
        for(const [operation,row,condition] of [['INSERT','NEW',''],['UPDATE','NEW',`WHEN OLD.${column} IS NOT NEW.${column}`],['DELETE','OLD','']]){
          db.exec(`CREATE TRIGGER IF NOT EXISTS hd_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} ${condition} BEGIN
            INSERT INTO provider_versions VALUES(${row}.owner,${row}.device,${row}.executor,${target.replace('{row}',row)},1)
            ON CONFLICT(owner,device,executor,target) DO UPDATE SET revision=revision+1; END`);
        }
      }
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
  private revision(db:DatabaseSync,c:FileOwnerContext,target:string):number {
    const row=db.prepare('SELECT revision FROM provider_versions WHERE owner=? AND device=? AND executor=? AND target=?').get(c.ownerId,c.deviceId,c.executorId,target);
    const value=row?.revision??0;
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new RuntimeError('PROVIDER_CONFIGURATION_INVALID');
    return value;
  }
  private transaction<T>(db:DatabaseSync,action:()=>T,write=false):T {
    db.exec(write?'BEGIN IMMEDIATE':'BEGIN');
    try{const result=action();db.exec('COMMIT');return result;}
    catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  }
  private change(db:DatabaseSync,c:FileOwnerContext,kind:ProviderChange['kind'],target:ProviderChange['target'],
      before:ProviderChange['before'],after:ProviderChange['after'],expected:number|undefined,apply:()=>void):ProviderChange {
    const key=kind+':'+target,current=this.revision(db,c,key);
    if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0))throw new RuntimeError('PROVIDER_CONFIGURATION_INVALID');
    if(expected!==undefined&&expected!==current)throw new RuntimeError('PROVIDER_CONFLICT');
    const changed=before!==after,revision=current+Number(changed);
    if(!Number.isSafeInteger(revision))throw new RuntimeError('PROVIDER_CONFIGURATION_INVALID');
    apply();
    if(this.revision(db,c,key)!==revision)throw new RuntimeError('PROVIDER_CONFIGURATION_INVALID');
    const receipt:ProviderChange={id:randomUUID(),kind,target,before,after,revision,changed,createdAt:new Date().toISOString()};
    db.prepare('INSERT INTO provider_changes(owner,device,executor,payload) VALUES(?,?,?,?)')
      .run(c.ownerId,c.deviceId,c.executorId,JSON.stringify(receipt));
    // Bound retained history per authority tuple; target revisions outlive pruning.
    db.prepare('DELETE FROM provider_changes WHERE owner=? AND device=? AND executor=? AND sequence NOT IN (SELECT sequence FROM provider_changes WHERE owner=? AND device=? AND executor=? ORDER BY sequence DESC LIMIT 200)')
      .run(c.ownerId,c.deviceId,c.executorId,c.ownerId,c.deviceId,c.executorId);
    return receipt;
  }
  async snapshot(context:FileOwnerContext):Promise<ProviderSettings> {
    this.check(context,'files.name');
    return this.withDatabase(db=>this.transaction(db,()=>{
      const keys=[context.ownerId,context.deviceId,context.executorId];
      const preferences=(['files.name','files.content'] as const).map(capability=>{
        const row=db.prepare('SELECT provider FROM preferences WHERE owner=? AND device=? AND executor=? AND capability=?').get(...keys,capability);
        const provider=(row?.provider??null) as SearchProvider|null;this.check(context,capability,provider);
        return {capability,provider,revision:this.revision(db,context,'preference:'+capability)};
      });
      const enabled=db.prepare('SELECT enabled FROM provider_enablement WHERE owner=? AND device=? AND executor=? AND provider=?').get(...keys,'everything');
      const changes=db.prepare('SELECT payload FROM provider_changes WHERE owner=? AND device=? AND executor=? ORDER BY sequence DESC LIMIT 20').all(...keys)
        .map(row=>JSON.parse(String(row.payload)) as ProviderChange);
      return {preferences,everything:{enabledOverride:enabled?enabled.enabled===1:null,revision:this.revision(db,context,'enablement:everything')},changes};
    }));
  }
  async set(context:FileOwnerContext,capability:SearchCapability,provider:SearchProvider|null,expectedRevision?:number):Promise<ProviderChange> {
    this.check(context,capability,provider);
    return this.withDatabase(db=>this.transaction(db,()=>{
      const keys=[context.ownerId,context.deviceId,context.executorId,capability];
      const row=db.prepare('SELECT provider FROM preferences WHERE owner=? AND device=? AND executor=? AND capability=?').get(...keys);
      const before=(row?.provider??null) as SearchProvider|null;this.check(context,capability,before);
      return this.change(db,context,'preference',capability,before,provider,expectedRevision,()=>{
        if(provider===null)db.prepare('DELETE FROM preferences WHERE owner=? AND device=? AND executor=? AND capability=?').run(...keys);
        else db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?) ON CONFLICT(owner,device,executor,capability) DO UPDATE SET provider=excluded.provider').run(...keys,provider);
      });
    },true));
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
  async setEnabled(context:FileOwnerContext,provider:SearchProvider,enabled:boolean|null,expectedRevision?:number):Promise<ProviderChange> {
    this.check(context,'files.name',provider);
    if(provider==='direct')throw new RuntimeError('PROVIDER_IMMUTABLE');
    if(enabled!==null&&typeof enabled!=='boolean')throw new RuntimeError('PROVIDER_CONFIGURATION_INVALID');
    return this.withDatabase(db=>this.transaction(db,()=>{
      const keys=[context.ownerId,context.deviceId,context.executorId,provider];
      const row=db.prepare('SELECT enabled FROM provider_enablement WHERE owner=? AND device=? AND executor=? AND provider=?').get(...keys);
      return this.change(db,context,'enablement','everything',row?row.enabled===1:null,enabled,expectedRevision,()=>{
        if(enabled===null)db.prepare('DELETE FROM provider_enablement WHERE owner=? AND device=? AND executor=? AND provider=?').run(...keys);
        else db.prepare('INSERT INTO provider_enablement VALUES(?,?,?,?,?) ON CONFLICT(owner,device,executor,provider) DO UPDATE SET enabled=excluded.enabled').run(...keys,Number(enabled));
      });
    },true));
  }
}
