import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { ShadowAction, TargetShadowPlan } from './target-shadow-plan.js';
const ComparableActionSchema=z.object({kind:z.enum(['FLATTEN','REDUCE','OPEN']),symbol:z.string(),venue:z.string(),side:z.enum(['BUY','SELL']),quoteQuantity:z.string().regex(/^\d+(?:\.\d+)?$/)});
const AuditSchema=z.object({signal_source:z.string().default(''),signal_count:z.number().int().nonnegative().default(0),target_request_hash:z.string().optional(),shadow_actions:z.array(ComparableActionSchema).optional(),loop_started_at_ms:z.number().int().nonnegative().optional(),route:z.object({selected:z.array(z.record(z.string(),z.unknown())).default([]),split_plans:z.array(z.record(z.string(),z.unknown())).default([])}).passthrough().default({selected:[],split_plans:[]}),execution:z.object({executed:z.array(z.record(z.string(),z.unknown())).default([])}).passthrough().default({executed:[]})}).passthrough();
function canonical(v:unknown):string{if(Array.isArray(v))return`[${v.map(canonical).join(',')}]`;if(v&&typeof v==='object')return`{${Object.entries(v as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;return JSON.stringify(v)}
function hash(v:unknown){return`sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`}
export interface ComparableAction{kind:'FLATTEN'|'REDUCE'|'OPEN';symbol:string;venue:string;side:'BUY'|'SELL';quoteQuantity:string}
function shadowActions(plan:TargetShadowPlan):ComparableAction[]{return plan.actions.map(a=>({kind:a.kind,symbol:a.symbol,venue:a.venue,side:a.side,quoteQuantity:a.quoteQuantity}))}
function legacyActions(raw:z.infer<typeof AuditSchema>):ComparableAction[]{return(raw.shadow_actions??[]).map(action=>({...action,symbol:action.symbol.toUpperCase(),venue:action.venue.toUpperCase(),quoteQuantity:new Decimal(action.quoteQuantity).toFixed()}))}
function aggregate(actions:ComparableAction[]):Map<string,Decimal>{const out=new Map<string,Decimal>();for(const a of actions){const key=`${a.kind}|${a.symbol}|${a.venue}|${a.side}`;out.set(key,(out.get(key)??new Decimal(0)).add(a.quoteQuantity))}return out}
export interface TargetShadowComparison{comparisonId:string;createdAt:string;accountId:string;shadowPlanId:string;bridgeAuditPath:string;bridgeAuditFingerprint:string;status:'MATCH'|'DIFFERENT'|'UNCOMPARABLE';confidence:'LOW'|'HIGH';reasons:string[];shadowActions:ComparableAction[];legacyActions:ComparableAction[];missingInLegacy:ComparableAction[];extraInLegacy:ComparableAction[]}
export function compareTargetShadowPlan(plan:TargetShadowPlan,auditRaw:unknown,path:string,auditMtimeMs:number,now=new Date()):TargetShadowComparison{
  const audit=AuditSchema.parse(auditRaw),shadow=shadowActions(plan),legacy=legacyActions(audit),reasons:string[]=[];
  const ageMs=now.getTime()-auditMtimeMs;
  if(!audit.signal_source.includes('real_trading_state_mainline.json'))reasons.push('bridge_audit_source_mismatch');
  if(ageMs<0||ageMs>30*60_000)reasons.push('bridge_audit_stale');
  if(!plan.sourceStateFingerprint||audit.target_request_hash!==plan.sourceStateFingerprint)reasons.push('target_request_fingerprint_mismatch');
  if(audit.shadow_actions===undefined)reasons.push('bridge_shadow_actions_unavailable');
  const sa=aggregate(shadow),la=aggregate(legacy),differentKeys=new Set<string>();
  for(const key of new Set([...sa.keys(),...la.keys()]))if(!(sa.get(key)??new Decimal(0)).eq(la.get(key)??new Decimal(0)))differentKeys.add(key);
  const actionKey=(a:ComparableAction)=>`${a.kind}|${a.symbol}|${a.venue}|${a.side}`;
  const missing=shadow.filter(a=>differentKeys.has(actionKey(a))),extra=legacy.filter(a=>differentKeys.has(actionKey(a)));
  let status:TargetShadowComparison['status'],confidence:TargetShadowComparison['confidence'];
  if(reasons.length>0){status='UNCOMPARABLE';confidence='LOW'}else if(differentKeys.size===0){status='MATCH';confidence='HIGH'}else{status='DIFFERENT';confidence='HIGH';reasons.push('aggregated_actions_differ')}
  return{comparisonId:randomUUID(),createdAt:now.toISOString(),accountId:plan.accountId,shadowPlanId:plan.planId,bridgeAuditPath:path,bridgeAuditFingerprint:hash(auditRaw),status,confidence,reasons,shadowActions:shadow,legacyActions:legacy,missingInLegacy:missing,extraInLegacy:extra}
}
export function readLatestBridgeAudit(directory:string):{audit:unknown;path:string;mtimeMs:number}{const names=readdirSync(directory).filter(name=>/^bridge_run_\d+_\d{8}_\d{6}\.json$/.test(name));if(names.length===0)throw new Error('bridge_audit_unavailable');const rows=names.map(name=>{const path=join(directory,name),stat=statSync(path);return{path,mtimeMs:stat.mtimeMs}}).sort((a,b)=>b.mtimeMs-a.mtimeMs);const latest=rows[0]!;return{...latest,audit:JSON.parse(readFileSync(latest.path,'utf8'))}}
export class TargetShadowComparisonStore{
  constructor(private readonly db:Database.Database,private readonly accountId:string){}
  create(plan:TargetShadowPlan,audit:unknown,path:string,mtime:number,now=new Date()):{comparison:TargetShadowComparison;reused:boolean}{
    if(plan.accountId!==this.accountId)throw new Error('target_shadow_comparison_account_mismatch');const c=compareTargetShadowPlan(plan,audit,path,mtime,now);
    return this.db.transaction(()=>{const result=this.db.prepare(`INSERT INTO target_shadow_comparisons(id,account_id,shadow_plan_id,bridge_audit_path,bridge_audit_fingerprint,status,confidence,comparison_json,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,shadow_plan_id,bridge_audit_fingerprint) DO NOTHING`).run(c.comparisonId,c.accountId,c.shadowPlanId,c.bridgeAuditPath,c.bridgeAuditFingerprint,c.status,c.confidence,JSON.stringify(c),c.createdAt);if(result.changes===1)return{comparison:c,reused:false};const old=this.db.prepare('SELECT comparison_json FROM target_shadow_comparisons WHERE account_id=? AND shadow_plan_id=? AND bridge_audit_fingerprint=?').get(this.accountId,plan.planId,c.bridgeAuditFingerprint) as {comparison_json:string};return{comparison:JSON.parse(old.comparison_json) as TargetShadowComparison,reused:true}})()
  }
  list(){return(this.db.prepare('SELECT comparison_json FROM target_shadow_comparisons WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(this.accountId)as Array<{comparison_json:string}>).map(r=>JSON.parse(r.comparison_json) as TargetShadowComparison)}
}
