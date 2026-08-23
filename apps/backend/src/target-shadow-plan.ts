import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { TargetStateSchema, buildTargetStatePreview } from './target-state-preview.js';

const CompilerVersion = 'target-shadow/v1';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`; }
function symbolIdentity(symbol:string):{raw:string;venue:string|null}{const match=/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_([A-Z0-9]+)_(USDT|USDC|USD)$/.exec(symbol);return match?{raw:`${match[2]}${match[3]}`,venue:match[1]!}:{raw:symbol.replaceAll('_',''),venue:null};}
interface Position { positionId:string; symbol:string; venue:string; side:'BUY'|'SELL'; notional:string; markPrice:string; updatedAt:string }
type UnclippedAction = Omit<ShadowAction,'clipIndex'|'clipCount'>;
export interface ShadowAction { kind:'FLATTEN'|'REDUCE'|'OPEN'; symbol:string; venue:string; side:'BUY'|'SELL'; quoteQuantity:string; reduceOnly:boolean; reason:string; phase:1|2; dependsOnPhase:1|null; clipIndex:number; clipCount:number }
export interface TargetShadowPlan { planId:string; createdAt:string; accountId:string; creatorUserId:string; compilerVersion:string; requestHash:string; sourceStateFingerprint:string; positionFingerprint:string; planFingerprint:string; executionAllowed:false; actions:ShadowAction[]; targets:ReturnType<typeof buildTargetStatePreview>['targets'] }

function clipActions(database:Database.Database, actions:UnclippedAction[]):ShadowAction[] {
  const row=database.prepare('SELECT max_order_notional FROM execution_risk_guard WHERE id=1').get() as {max_order_notional:string};
  const limit=new Decimal(row.max_order_notional);
  return actions.flatMap(action=>{
    const total=new Decimal(action.quoteQuantity); const count=Math.max(1,total.div(limit).ceil().toNumber());
    let remaining=total;
    return Array.from({length:count},(_,index)=>{const amount=Decimal.min(remaining,limit);remaining=remaining.sub(amount);return{...action,quoteQuantity:amount.toFixed(),clipIndex:index+1,clipCount:count};});
  });
}
function positions(database: Database.Database): Position[] {
  const rows=database.prepare('SELECT position_id,symbol,venue,quantity,mark_price,updated_at FROM live_positions ORDER BY symbol,position_id').all() as Array<Record<string,string>>;
  return rows.filter(r=>!new Decimal(r.quantity).isZero()&&new Decimal(r.mark_price).gt(0)).map(r=>({positionId:r.position_id,symbol:r.symbol,venue:r.venue,side:new Decimal(r.quantity).isNegative()?'SELL':'BUY',notional:new Decimal(r.quantity).abs().mul(r.mark_price).toFixed(),markPrice:r.mark_price,updatedAt:r.updated_at}));
}
export function compileTargetShadowPlan(database:Database.Database, raw:unknown, accountId:string, creatorUserId:string, now=new Date()):TargetShadowPlan {
  const state=TargetStateSchema.parse(raw);
  if (state.positions.some((position) => position.valid_until_ms !== undefined && position.valid_until_ms <= now.getTime())) {
    throw new TargetShadowPlanError('target_state_expired');
  }
  const normalizedTargetKeys=state.positions.map(position=>symbolIdentity(position.symbol).raw);
  const duplicateSymbols=normalizedTargetKeys.filter((symbol,index,all)=>all.indexOf(symbol)!==index);
  if(duplicateSymbols.length>0) throw new TargetShadowPlanError('duplicate_target_symbol');
  const preview=buildTargetStatePreview(state,now); const current=positions(database); const unclippedActions:UnclippedAction[]=[];
  for(const target of preview.targets){
    const targetIdentity=symbolIdentity(target.symbol);
    const matching=current.filter(p=>{const identity=symbolIdentity(p.symbol);return identity.raw===targetIdentity.raw&&(targetIdentity.venue===null||identity.venue===targetIdentity.venue)}); const same=matching.filter(p=>p.side===target.targetSide); const opposite=matching.filter(p=>p.side!==target.targetSide);
    for(const p of opposite) unclippedActions.push({kind:'FLATTEN',symbol:p.symbol,venue:p.venue,side:p.side==='BUY'?'SELL':'BUY',quoteQuantity:p.notional,reduceOnly:true,reason:'flatten_opposite_position',phase:1,dependsOnPhase:null});
    const requested=new Decimal(target.targetQuoteQuantity); const sameTotal=same.reduce((n,p)=>n.add(p.notional),new Decimal(0));
    if(requested.isZero()) { for(const p of same) unclippedActions.push({kind:'FLATTEN',symbol:p.symbol,venue:p.venue,side:p.side==='BUY'?'SELL':'BUY',quoteQuantity:p.notional,reduceOnly:true,reason:'flatten_same_side_position',phase:1,dependsOnPhase:null}); continue; }
    if(requested.lt(sameTotal)) { const reduction=sameTotal.sub(requested); for(const p of same){ const amount=reduction.mul(new Decimal(p.notional).div(sameTotal)); if(amount.gt(0)) unclippedActions.push({kind:'REDUCE',symbol:p.symbol,venue:p.venue,side:p.side==='BUY'?'SELL':'BUY',quoteQuantity:amount.toFixed(),reduceOnly:true,reason:'rebalance_existing_position',phase:1,dependsOnPhase:null}); } continue; }
    const extra=requested.sub(sameTotal); if(extra.gt(0)){ const venue=target.preferredVenue ?? target.routeCandidates[0]!.split('_',1)[0]!; const symbol=target.routeCandidates.find(s=>s.startsWith(`${venue}_`)) ?? target.routeCandidates[0]!; unclippedActions.push({kind:'OPEN',symbol,venue,side:target.targetSide,quoteQuantity:extra.toFixed(),reduceOnly:false,reason:'increase_target_exposure',phase:2,dependsOnPhase:1}); }
  }
  const hasPhaseOne=unclippedActions.some(action=>action.phase===1);
  const phasedActions=unclippedActions.map(action=>action.kind==='OPEN'&&!hasPhaseOne
    ? {...action,phase:1 as const,dependsOnPhase:null}
    : action);
  const actions=clipActions(database,phasedActions);
  const sourceStateFingerprint=typeof state.meta.state_fingerprint==='string'&&/^sha256:[a-f0-9]{64}$/.test(state.meta.state_fingerprint)
    ? state.meta.state_fingerprint : '';
  const positionFingerprint=hash(current); const planCore={compilerVersion:CompilerVersion,requestHash:preview.requestHash,sourceStateFingerprint,positionFingerprint,actions,targets:preview.targets};
  return {planId:randomUUID(),createdAt:now.toISOString(),accountId,creatorUserId,compilerVersion:CompilerVersion,requestHash:preview.requestHash,sourceStateFingerprint,positionFingerprint,planFingerprint:hash(planCore),executionAllowed:false,actions,targets:preview.targets};
}
export class TargetShadowPlanError extends Error {
  constructor(readonly code:string){ super(code); this.name='TargetShadowPlanError'; }
}
export class TargetShadowPlanStore {
  constructor(private readonly database:Database.Database,private readonly boundAccountId:string){}
  create(raw:unknown,accountId:string,creatorUserId:string,now=new Date()):{plan:TargetShadowPlan;reused:boolean} {
    if(accountId!==this.boundAccountId) throw new TargetShadowPlanError('target_shadow_account_mismatch');
    const compiled=compileTargetShadowPlan(this.database,raw,accountId,creatorUserId,now);
    const existing=this.database.prepare('SELECT compiled_plan_json FROM target_shadow_plans WHERE account_id=? AND request_hash=? AND position_fingerprint=? AND compiler_version=?').get(accountId,compiled.requestHash,compiled.positionFingerprint,compiled.compilerVersion) as {compiled_plan_json:string}|undefined;
    if(existing) return {plan:JSON.parse(existing.compiled_plan_json) as TargetShadowPlan,reused:true};
    this.database.prepare(`INSERT INTO target_shadow_plans (id,account_id,creator_user_id,request_hash,position_fingerprint,plan_fingerprint,compiler_version,target_state_json,compiled_plan_json,execution_allowed,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)`).run(compiled.planId,accountId,creatorUserId,compiled.requestHash,compiled.positionFingerprint,compiled.planFingerprint,compiled.compilerVersion,canonical(TargetStateSchema.parse(raw)),JSON.stringify(compiled),compiled.createdAt); return {plan:compiled,reused:false};
  }
  get(id:string,accountId:string):TargetShadowPlan|null { const row=this.database.prepare('SELECT compiled_plan_json FROM target_shadow_plans WHERE id=? AND account_id=?').get(id,accountId) as {compiled_plan_json:string}|undefined; return row?JSON.parse(row.compiled_plan_json) as TargetShadowPlan:null; }
  list(accountId:string,limit=20):TargetShadowPlan[]{ return (this.database.prepare('SELECT compiled_plan_json FROM target_shadow_plans WHERE account_id=? ORDER BY created_at DESC LIMIT ?').all(accountId,limit) as Array<{compiled_plan_json:string}>).map(r=>JSON.parse(r.compiled_plan_json) as TargetShadowPlan); }
}
